const { contextBridge } = require("electron");

// Intentionally expose no filesystem, process, shell, or arbitrary IPC APIs.
// The existing React application uses its HTTP API client for backend access.
contextBridge.exposeInMainWorld("oneNexaDesktop", Object.freeze({
  appName: "OneNexa",
  platform: process.platform,
  isDesktop: true,
}));
