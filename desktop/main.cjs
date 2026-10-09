const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const net = require("node:net");

const APP_NAME = "OneNexa";
const API_ORIGIN = process.env.ONENEXA_API_ORIGIN || "http://127.0.0.1:7432";
const API_HEALTH_URL = new URL("/health", API_ORIGIN).toString();
const isDev = !app.isPackaged;
let mainWindow = null;
let backendProcess = null;
let backendLogStream = null;

function openBackendLog() {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    backendLogStream = fs.createWriteStream(path.join(logDirectory, "backend.log"), { flags: "a" });
    backendLogStream.write("\n\n--- OneNexa backend start " + new Date().toISOString() + " ---\n");
  } catch (error) {
    console.error("Unable to open OneNexa backend log:", error);
  }
}

function attachBackendDiagnostics(child) {
  if (child.stdout) child.stdout.on("data", (data) => backendLogStream?.write(data));
  if (child.stderr) child.stderr.on("data", (data) => backendLogStream?.write(data));
  child.once("error", (error) => {
    backendLogStream?.write("\nSPAWN ERROR: " + (error.stack || error.message) + "\n");
    dialog.showErrorBox(
      "OneNexa local backend could not start",
      "The backend executable could not be launched. A diagnostic log is saved in OneNexa's user data folder under logs\\backend.log.\n\n" + error.message
    );
  });
  child.once("exit", (code, signal) => {
    backendLogStream?.write("\nBACKEND EXIT: code=" + code + ", signal=" + signal + "\n");
  });
}

function waitForPort(url, timeoutMs = 12000) {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const host = parsed.hostname;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      let settled = false;

      const finish = (ready) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ready) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 350);
      };

      socket.setTimeout(900);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    };
    attempt();
  });
}

function launchDevelopmentBackend() {
  if (!isDev || process.env.ONENEXA_SKIP_BACKEND === "1") return;
  const root = path.resolve(__dirname, "..");
  const command = process.platform === "win32" ? "python" : "python3";
  backendProcess = spawn(command, ["-m", "backend.run"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "7432",
      HOST: "127.0.0.1",
      ENV_MODE: process.env.ENV_MODE || "development",
      ONENEXA_LOCAL_FIRST_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  attachBackendDiagnostics(backendProcess);
}

// Packaged builds use the bundled backend executable instead of requiring Python
// to be installed separately on the user's PC.
function launchPackagedBackend() {
  if (isDev || process.env.ONENEXA_SKIP_BACKEND === "1") return;
  openBackendLog();
  const executable = path.join(process.resourcesPath, "backend", "onenexa-backend.exe");
  backendLogStream?.write("Executable: " + executable + "\n");
  backendLogStream?.write("User data: " + app.getPath("userData") + "\n");
  backendProcess = spawn(executable, [], {
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      PORT: "7432",
      HOST: "127.0.0.1",
      ENV_MODE: process.env.ENV_MODE || "development",
      ONENEXA_LOCAL_FIRST_ENABLED: "1",
      ONENEXA_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  attachBackendDiagnostics(backendProcess);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    icon: path.join(process.resourcesPath, "app-icon.ico"),
    backgroundColor: "#f6f8fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Do not permit arbitrary navigation or pop-up windows in the privileged shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedLocalFile = url.startsWith("file://");
    const allowedDevelopmentServer = isDev && /^http:\/\/127\.0\.0\.1:3000\//.test(url);
    if (!allowedLocalFile && !allowedDevelopmentServer) event.preventDefault();
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:3000");
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../frontend/dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  launchDevelopmentBackend();
  launchPackagedBackend();

  const ready = await waitForPort(API_HEALTH_URL, isDev ? 12000 : 15000);
  if (!ready) {
    const logPath = path.join(app.getPath("userData"), "logs", "backend.log");
    await dialog.showMessageBox({
      type: "warning",
      title: "OneNexa backend is not available",
      message: "The OneNexa desktop shell is starting, but its local API is not reachable.",
      detail: isDev
        ? "Check your development Python environment and local database."
        : "Diagnostic log: " + logPath + "\n\nThe backend may be missing configuration or may have stopped during startup. Share this log so the exact cause can be fixed.",
      buttons: ["Continue", "Exit"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 1) app.quit();
    });
  }

  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  backendLogStream?.end();
});
