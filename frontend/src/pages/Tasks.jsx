import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckSquare, Plus, Search, Filter, RefreshCw, Calendar, Clock,
  AlertCircle, CheckCircle2, ChevronRight, X, User, Users,
  Building2, MessageSquare, Download, Trash2, Edit3, Send,
  Upload, Tag, ChevronDown, Check, ArrowUpDown, FileText
} from "lucide-react";
import { toast } from "sonner";
import { format, parseISO, isToday, isTomorrow, isPast } from "date-fns";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useDark } from "@/hooks/useDark";
import GifLoader, { MiniLoader } from "@/components/ui/GifLoader";
import { getTasksCache, setTasksCache } from "@/lib/tasksPrefetch";

const COLORS = {
  deepBlue: "#0D3B66",
  mediumBlue: "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  lightGreen: "#5CCB5F",
  coral: "#FF6B6B",
  amber: "#F59E0B",
};

const DEPARTMENTS = [
  { value: "all", label: "All Departments" },
  { value: "gst", label: "GST" },
  { value: "income_tax", label: "INCOME TAX" },
  { value: "accounts", label: "ACCOUNTS" },
  { value: "tds", label: "TDS" },
  { value: "roc", label: "ROC" },
  { value: "trademark", label: "TRADEMARK" },
  { value: "msme_smadhan", label: "MSME SMADHAN" },
  { value: "fema", label: "FEMA" },
  { value: "dsc", label: "DSC" },
  { value: "other", label: "OTHER" },
];

const PRIORITIES = [
  { value: "low", label: "Low", color: "bg-slate-100 text-slate-700" },
  { value: "medium", label: "Medium", color: "bg-blue-100 text-blue-700" },
  { value: "high", label: "High", color: "bg-amber-100 text-amber-800" },
  { value: "urgent", label: "Urgent", color: "bg-red-100 text-red-700" },
];

const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "on_hold", label: "On Hold" },
];

export default function Tasks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isDark = useDark();

  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilter, setSelectedFilter] = useState(searchParams.get("filter") || "all");
  const [selectedDept, setSelectedDept] = useState("all");
  const [selectedPriority, setSelectedPriority] = useState("all");
  const [selectedAssignee, setSelectedAssignee] = useState("all");

  // Modals & Active items
  const [showCreateModal, setShowCreateModal] = useState(Boolean(searchParams.get("newTask")));
  const [activeTask, setActiveTask] = useState(null);
  const [isEditingActive, setIsEditingActive] = useState(Boolean(searchParams.get("edit")));
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [submittingComment, setSubmittingComment] = useState(false);

  // New task form state
  const [createForm, setCreateForm] = useState({
    title: "",
    description: "",
    category: "other",
    priority: "medium",
    status: "pending",
    assigned_to: user?.id || "",
    sub_assignees: [],
    client_id: "",
    due_date: "",
    is_recurring: false,
    recurrence_pattern: "monthly",
    recurrence_interval: 1,
  });
  const [savingTask, setSavingTask] = useState(false);

  // Fetch initial data
  const fetchData = useCallback(async (bypassCache = false) => {
    if (!bypassCache) {
      const cached = getTasksCache();
      if (cached?.tasks?.length) {
        setTasks(cached.tasks);
        if (cached.users) setUsers(cached.users);
        if (cached.clients) setClients(cached.clients);
        setLoading(false);
      }
    }

    try {
      setRefreshing(true);
      const [tasksRes, usersRes, clientsRes] = await Promise.all([
        api.get("/tasks", { params: { page: 1, page_size: 500 } }).catch(() => ({ data: [] })),
        api.get("/users").catch(() => ({ data: [] })),
        api.get("/clients", { params: { page: 1, page_size: 300 } }).catch(() => ({ data: [] })),
      ]);

      const fetchedTasks = Array.isArray(tasksRes.data) ? tasksRes.data : (tasksRes.data?.tasks || []);
      const fetchedUsers = Array.isArray(usersRes.data) ? usersRes.data : [];
      const fetchedClients = Array.isArray(clientsRes.data) ? clientsRes.data : (clientsRes.data?.clients || []);

      setTasks(fetchedTasks);
      setUsers(fetchedUsers);
      setClients(fetchedClients);
      setTasksCache({ tasks: fetchedTasks, users: fetchedUsers, clients: fetchedClients });
    } catch (err) {
      console.error("Failed to load tasks data:", err);
      toast.error("Failed to fetch tasks.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Deep-link handling: ?taskId=... &edit=1 &newTask=1
  useEffect(() => {
    const taskIdParam = searchParams.get("taskId");
    const editParam = searchParams.get("edit");
    const newParam = searchParams.get("newTask");
    const filterParam = searchParams.get("filter");

    if (newParam) {
      setShowCreateModal(true);
    }
    if (filterParam) {
      setSelectedFilter(filterParam);
    }
    if (taskIdParam && tasks.length) {
      const target = tasks.find((t) => t.id === taskIdParam);
      if (target) {
        setActiveTask(target);
        if (editParam) setIsEditingActive(true);
      }
    }
  }, [searchParams, tasks]);

  // Load comments when active task changes
  useEffect(() => {
    if (activeTask?.id) {
      setCommentsLoading(true);
      api.get(`/tasks/${activeTask.id}/comments`)
        .then((res) => {
          setComments(Array.isArray(res.data) ? res.data : []);
        })
        .catch(() => setComments([]))
        .finally(() => setCommentsLoading(false));
    } else {
      setComments([]);
    }
  }, [activeTask?.id]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    let result = [...tasks];

    // Status / quick tabs
    const currentUserId = user?.id;
    if (selectedFilter === "my-tasks" || selectedFilter === "assigned-to-me") {
      result = result.filter((t) => t.assigned_to === currentUserId || (t.sub_assignees || []).includes(currentUserId));
    } else if (selectedFilter === "assigned-by-me") {
      result = result.filter((t) => t.created_by === currentUserId);
    } else if (selectedFilter === "today_new") {
      result = result.filter((t) => t.created_at && isToday(parseISO(t.created_at)));
    } else if (selectedFilter === "overdue") {
      result = result.filter((t) => t.due_date && isPast(parseISO(t.due_date)) && t.status !== "completed");
    } else if (selectedFilter === "completed") {
      result = result.filter((t) => t.status === "completed");
    }

    // Category / Department
    if (selectedDept !== "all") {
      result = result.filter((t) => (t.category || "other").toLowerCase() === selectedDept.toLowerCase());
    }

    // Priority
    if (selectedPriority !== "all") {
      result = result.filter((t) => (t.priority || "medium").toLowerCase() === selectedPriority.toLowerCase());
    }

    // Assignee
    if (selectedAssignee !== "all") {
      result = result.filter((t) => t.assigned_to === selectedAssignee);
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.assigned_to_name || "").toLowerCase().includes(q) ||
        (t.client_name || "").toLowerCase().includes(q)
      );
    }

    return result;
  }, [tasks, selectedFilter, selectedDept, selectedPriority, selectedAssignee, searchQuery, user?.id]);

  // Statistics calculation
  const stats = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const overdue = tasks.filter((t) => t.due_date && isPast(parseISO(t.due_date)) && t.status !== "completed").length;
    const dueToday = tasks.filter((t) => t.due_date && isToday(parseISO(t.due_date)) && t.status !== "completed").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress" || t.status === "pending").length;
    return { total, completed, overdue, dueToday, inProgress };
  }, [tasks]);

  // Toggle complete
  const handleToggleComplete = async (task, e) => {
    e?.stopPropagation();
    const newStatus = task.status === "completed" ? "pending" : "completed";
    try {
      const res = await api.patch(`/tasks/${task.id}`, { status: newStatus });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)));
      if (activeTask?.id === task.id) {
        setActiveTask((prev) => ({ ...prev, status: newStatus }));
      }
      toast.success(newStatus === "completed" ? "Task marked as completed!" : "Task marked as pending.");
    } catch (err) {
      toast.error("Failed to update status.");
    }
  };

  // Create Task
  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!createForm.title.trim()) {
      return toast.error("Task title is required.");
    }
    setSavingTask(true);
    try {
      const payload = {
        ...createForm,
        due_date: createForm.due_date ? new Date(createForm.due_date).toISOString() : null,
      };
      const res = await api.post("/tasks", payload);
      const newTask = res.data;
      setTasks((prev) => [newTask, ...prev]);
      setShowCreateModal(false);
      setCreateForm({
        title: "",
        description: "",
        category: "other",
        priority: "medium",
        status: "pending",
        assigned_to: user?.id || "",
        sub_assignees: [],
        client_id: "",
        due_date: "",
        is_recurring: false,
        recurrence_pattern: "monthly",
        recurrence_interval: 1,
      });
      toast.success("Task created successfully!");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create task.");
    } finally {
      setSavingTask(false);
    }
  };

  // Update Task
  const handleUpdateTask = async (e) => {
    e.preventDefault();
    if (!activeTask?.title?.trim()) return toast.error("Title cannot be empty.");
    setSavingTask(true);
    try {
      const payload = {
        title: activeTask.title,
        description: activeTask.description,
        status: activeTask.status,
        priority: activeTask.priority,
        category: activeTask.category,
        assigned_to: activeTask.assigned_to,
        sub_assignees: activeTask.sub_assignees || [],
        client_id: activeTask.client_id || null,
        due_date: activeTask.due_date ? new Date(activeTask.due_date).toISOString() : null,
      };
      const res = await api.patch(`/tasks/${activeTask.id}`, payload);
      setTasks((prev) => prev.map((t) => (t.id === activeTask.id ? { ...t, ...payload } : t)));
      setIsEditingActive(false);
      toast.success("Task updated successfully!");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to update task.");
    } finally {
      setSavingTask(false);
    }
  };

  // Delete Task
  const handleDeleteTask = async (taskId) => {
    if (!window.confirm("Are you sure you want to delete this task?")) return;
    try {
      await api.delete(`/tasks/${taskId}`);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      if (activeTask?.id === taskId) setActiveTask(null);
      toast.success("Task deleted.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to delete task.");
    }
  };

  // Add Comment
  const handleAddComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim() || !activeTask?.id) return;
    setSubmittingComment(true);
    try {
      const res = await api.post(`/tasks/${activeTask.id}/comments`, { text: commentText.trim() });
      setComments((prev) => [...prev, res.data]);
      setCommentText("");
      toast.success("Comment added.");
    } catch (err) {
      toast.error("Failed to post comment.");
    } finally {
      setSubmittingComment(false);
    }
  };

  // Export PDF
  const handleExportPDF = async (taskId) => {
    try {
      const response = await api.get(`/tasks/${taskId}/export-log-pdf`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `task_lifecycle_${taskId}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("PDF exported successfully!");
    } catch {
      toast.error("Failed to export PDF.");
    }
  };

  return (
    <div className="w-full min-h-screen bg-slate-50/60 p-4 sm:p-6 lg:p-8 space-y-6">
      {/* ── HEADER ROW (matches index.html data-attributes) ── */}
      <div data-task-header-row="true" className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div data-task-header-title-wrap="true">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#1F6FB2]">
            <CheckSquare className="h-4 w-4" />
            <span>Workflow & Operations</span>
          </div>
          <h1
            data-task-header-title="true"
            className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight"
          >
            Task Management
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Track, assign, collaborate, and monitor all organizational task lifecycles in real time.
          </p>
        </div>

        <div data-task-header-actions="true" className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0D3B66] text-white text-xs font-bold hover:bg-[#1F6FB2] shadow-sm transition"
          >
            <Plus className="h-4 w-4" />
            <span>New Task</span>
          </button>

          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 transition shadow-sm"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={() => setSelectedFilter(selectedFilter === "completed" ? "all" : "completed")}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border text-xs font-bold transition shadow-sm ${
              selectedFilter === "completed"
                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>Completed</span>
          </button>

          <button
            onClick={() => setSelectedFilter(selectedFilter === "overdue" ? "all" : "overdue")}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border text-xs font-bold transition shadow-sm ${
              selectedFilter === "overdue"
                ? "border-red-500 bg-red-50 text-red-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <AlertCircle className="h-4 w-4 text-red-500" />
            <span>Overdue ({stats.overdue})</span>
          </button>
        </div>
      </div>

      {/* ── STATS CARDS ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Total Tasks</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.total}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Active registry</div>
        </div>

        <div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-blue-600">In Progress</div>
          <div className="text-2xl font-black text-blue-900 mt-1">{stats.inProgress}</div>
          <div className="text-[11px] text-blue-600 mt-0.5">Active workload</div>
        </div>

        <div className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-amber-600">Due Today</div>
          <div className="text-2xl font-black text-amber-900 mt-1">{stats.dueToday}</div>
          <div className="text-[11px] text-amber-600 mt-0.5">Urgent attention</div>
        </div>

        <div className="rounded-2xl border border-red-100 bg-red-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-red-600">Overdue</div>
          <div className="text-2xl font-black text-red-900 mt-1">{stats.overdue}</div>
          <div className="text-[11px] text-red-600 mt-0.5">Past target date</div>
        </div>

        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-600">Completed</div>
          <div className="text-2xl font-black text-emerald-900 mt-1">{stats.completed}</div>
          <div className="text-[11px] text-emerald-600 mt-0.5">Resolved tasks</div>
        </div>
      </div>

      {/* ── FILTER & SEARCH CONTROLS ── */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs space-y-3.5">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title, description, client name, or assignee..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50/50 outline-none focus:border-[#1F6FB2] focus:bg-white transition"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by department"
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white text-slate-700 outline-none"
            >
              {DEPARTMENTS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>

            <select
              aria-label="Filter by priority"
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white text-slate-700 outline-none"
            >
              <option value="all">All Priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>

            <select
              aria-label="Filter by assignee"
              value={selectedAssignee}
              onChange={(e) => setSelectedAssignee(e.target.value)}
              className="px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white text-slate-700 outline-none"
            >
              <option value="all">All Assignees</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-1 border-t border-slate-100 text-xs">
          {[
            { id: "all", label: "All Tasks" },
            { id: "my-tasks", label: "My Tasks" },
            { id: "assigned-by-me", label: "Assigned By Me" },
            { id: "today_new", label: "New Today" },
            { id: "overdue", label: "Overdue" },
            { id: "completed", label: "Completed" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSelectedFilter(tab.id)}
              className={`px-3 py-1.5 rounded-lg font-semibold transition whitespace-nowrap ${
                selectedFilter === tab.id
                  ? "bg-[#0D3B66] text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              {tab.label}
            </button>
          ))}
          <span className="text-[11px] text-slate-400 ml-auto pr-1">
            Showing {filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
      </div>

      {/* ── TASKS TABLE / LIST ── */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center">
            <MiniLoader />
            <p className="text-xs text-slate-400 mt-2">Loading tasks registry...</p>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="py-16 text-center">
            <CheckSquare className="h-10 w-10 text-slate-300 mx-auto mb-2" />
            <h3 className="text-sm font-bold text-slate-700">No tasks found</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
              There are no tasks matching the selected filters or search query.
            </p>
            <button
              onClick={() => { setSelectedFilter("all"); setSelectedDept("all"); setSelectedPriority("all"); setSearchQuery(""); }}
              className="mt-4 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              Clear Filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-200/60">
                <tr>
                  <th className="py-3 px-4 w-10">Done</th>
                  <th className="py-3 px-4">Task</th>
                  <th className="py-3 px-4">Department</th>
                  <th className="py-3 px-4">Assignee</th>
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Priority</th>
                  <th className="py-3 px-4">Due Date</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTasks.map((task) => {
                  const isDone = task.status === "completed";
                  const isTaskOverdue = task.due_date && isPast(parseISO(task.due_date)) && !isDone;
                  const priorityMeta = PRIORITIES.find((p) => p.value === (task.priority || "medium")) || PRIORITIES[1];

                  return (
                    <tr
                      key={task.id}
                      onClick={() => { setActiveTask(task); setIsEditingActive(false); }}
                      className="hover:bg-slate-50/80 cursor-pointer transition group"
                    >
                      <td className="py-3.5 px-4" onClick={(e) => handleToggleComplete(task, e)}>
                        <button
                          type="button"
                          className={`h-5 w-5 rounded-md border flex items-center justify-center transition ${
                            isDone
                              ? "bg-emerald-600 border-emerald-600 text-white"
                              : "border-slate-300 hover:border-[#1F6FB2] bg-white"
                          }`}
                        >
                          {isDone && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                        </button>
                      </td>

                      <td className="py-3.5 px-4 max-w-xs">
                        <div className={`font-semibold text-slate-900 line-clamp-1 ${isDone ? "line-through text-slate-400" : ""}`}>
                          {task.title}
                        </div>
                        {task.description && (
                          <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                            {task.description}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 uppercase">
                          {task.category || "General"}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <div className="h-6 w-6 rounded-full bg-[#0D3B66] text-white text-[10px] font-bold flex items-center justify-center">
                            {(task.assigned_to_name || "U")[0].toUpperCase()}
                          </div>
                          <span className="text-slate-800 font-medium">
                            {task.assigned_to_name || "Unassigned"}
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {task.client_name ? (
                          <span className="text-slate-700 font-medium flex items-center gap-1">
                            <Building2 className="h-3 w-3 text-slate-400" />
                            {task.client_name}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${priorityMeta.color}`}>
                          {priorityMeta.label}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {task.due_date ? (
                          <div className={`flex items-center gap-1 text-[11px] font-semibold ${isTaskOverdue ? "text-red-600" : "text-slate-600"}`}>
                            <Calendar className="h-3 w-3 text-slate-400" />
                            <span>{format(parseISO(task.due_date), "dd MMM yyyy")}</span>
                            {isTaskOverdue && <span className="text-[9px] bg-red-100 px-1 rounded text-red-700">Late</span>}
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[11px]">No deadline</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5 opacity-80 group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => { setActiveTask(task); setIsEditingActive(true); }}
                            className="p-1 rounded-md text-slate-400 hover:text-[#1F6FB2] hover:bg-slate-100"
                            title="Edit task"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleExportPDF(task.id)}
                            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                            title="Export Lifecycle PDF"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteTask(task.id)}
                            className="p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                            title="Delete task"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CREATE TASK MODAL ── */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-xl rounded-2xl bg-white shadow-xl border border-slate-200 overflow-hidden"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-lg bg-[#0D3B66] text-white flex items-center justify-center">
                    <Plus className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Create New Task</h3>
                    <p className="text-[11px] text-slate-500">Define work, department, assignee, and schedule</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="p-1 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleCreateTask} className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Task Title <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={createForm.title}
                    onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                    placeholder="e.g. Prepare and verify GSTR-3B return for Q3"
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#1F6FB2]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Description & Instructions
                  </label>
                  <textarea
                    rows={3}
                    value={createForm.description}
                    onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                    placeholder="Provide context, required documents, or step-by-step guidance..."
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#1F6FB2]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Department</label>
                    <select
                      value={createForm.category}
                      onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white outline-none"
                    >
                      {DEPARTMENTS.filter((d) => d.value !== "all").map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Priority</label>
                    <select
                      value={createForm.priority}
                      onChange={(e) => setCreateForm({ ...createForm, priority: e.target.value })}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white outline-none"
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Assignee</label>
                    <select
                      value={createForm.assigned_to}
                      onChange={(e) => setCreateForm({ ...createForm, assigned_to: e.target.value })}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white outline-none"
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Client (Optional)</label>
                    <select
                      value={createForm.client_id}
                      onChange={(e) => setCreateForm({ ...createForm, client_id: e.target.value })}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white outline-none"
                    >
                      <option value="">None / Internal</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.company_name || c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Due Date</label>
                  <input
                    type="date"
                    value={createForm.due_date}
                    onChange={(e) => setCreateForm({ ...createForm, due_date: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingTask}
                    className="px-4 py-2 text-xs font-bold text-white bg-[#0D3B66] hover:bg-[#1F6FB2] rounded-xl shadow-xs transition"
                  >
                    {savingTask ? "Creating..." : "Create Task"}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── TASK DETAIL / EDIT SLIDEOVER MODAL ── */}
      <AnimatePresence>
        {activeTask && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => handleToggleComplete(activeTask, e)}
                    className={`h-5 w-5 rounded-md border flex items-center justify-center transition ${
                      activeTask.status === "completed"
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-slate-300 hover:border-[#1F6FB2] bg-white"
                    }`}
                  >
                    {activeTask.status === "completed" && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                  </button>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Task Details
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditingActive(!isEditingActive)}
                    className={`p-1.5 rounded-lg text-xs font-semibold border flex items-center gap-1 transition ${
                      isEditingActive ? "bg-blue-50 border-blue-200 text-[#1F6FB2]" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    <span>{isEditingActive ? "Cancel Edit" : "Edit"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportPDF(activeTask.id)}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-semibold flex items-center gap-1"
                    title="Export Audit Trail"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>PDF</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTask(null)}
                    className="p-1 text-slate-400 hover:text-slate-600 ml-1"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="p-5 flex-1 overflow-y-auto space-y-5">
                {isEditingActive ? (
                  <form onSubmit={handleUpdateTask} className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Task Title</label>
                      <input
                        type="text"
                        value={activeTask.title || ""}
                        onChange={(e) => setActiveTask({ ...activeTask, title: e.target.value })}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#1F6FB2]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
                      <textarea
                        rows={3}
                        value={activeTask.description || ""}
                        onChange={(e) => setActiveTask({ ...activeTask, description: e.target.value })}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#1F6FB2]"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Status</label>
                        <select
                          value={activeTask.status || "pending"}
                          onChange={(e) => setActiveTask({ ...activeTask, status: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white"
                        >
                          {STATUSES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Priority</label>
                        <select
                          value={activeTask.priority || "medium"}
                          onChange={(e) => setActiveTask({ ...activeTask, priority: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white"
                        >
                          {PRIORITIES.map((p) => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Department</label>
                        <select
                          value={activeTask.category || "other"}
                          onChange={(e) => setActiveTask({ ...activeTask, category: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white"
                        >
                          {DEPARTMENTS.filter((d) => d.value !== "all").map((d) => (
                            <option key={d.value} value={d.value}>{d.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Assignee</label>
                        <select
                          value={activeTask.assigned_to || ""}
                          onChange={(e) => setActiveTask({ ...activeTask, assigned_to: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white"
                        >
                          <option value="">Unassigned</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Due Date</label>
                        <input
                          type="date"
                          value={activeTask.due_date ? activeTask.due_date.slice(0, 10) : ""}
                          onChange={(e) => setActiveTask({ ...activeTask, due_date: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setIsEditingActive(false)}
                        className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingTask}
                        className="px-3 py-1.5 text-xs font-bold text-white bg-[#0D3B66] hover:bg-[#1F6FB2] rounded-lg shadow-xs"
                      >
                        {savingTask ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">{activeTask.title}</h2>
                      <p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap leading-relaxed">
                        {activeTask.description || "No description provided."}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs">
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Status</span>
                        <span className="font-semibold text-slate-800 capitalize mt-0.5 inline-block">
                          {activeTask.status || "pending"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Priority</span>
                        <span className="font-semibold text-slate-800 capitalize mt-0.5 inline-block">
                          {activeTask.priority || "medium"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Department</span>
                        <span className="font-semibold text-slate-800 uppercase mt-0.5 inline-block">
                          {activeTask.category || "other"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Due Date</span>
                        <span className="font-semibold text-slate-800 mt-0.5 inline-block">
                          {activeTask.due_date ? format(parseISO(activeTask.due_date), "dd MMM yyyy") : "None"}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-slate-600 border-b border-slate-100 pb-3">
                      <div>
                        <span className="text-slate-400">Assigned To: </span>
                        <span className="font-semibold text-slate-800">{activeTask.assigned_to_name || "Unassigned"}</span>
                      </div>
                      {activeTask.client_name && (
                        <div>
                          <span className="text-slate-400">Client: </span>
                          <span className="font-semibold text-slate-800">{activeTask.client_name}</span>
                        </div>
                      )}
                    </div>

                    {/* Comments section */}
                    <div className="space-y-3 pt-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                        <MessageSquare className="h-4 w-4 text-[#1F6FB2]" />
                        <span>Activity & Comments ({comments.length})</span>
                      </div>

                      <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                        {commentsLoading ? (
                          <p className="text-xs text-slate-400">Loading comments...</p>
                        ) : comments.length === 0 ? (
                          <p className="text-xs text-slate-400">No comments yet. Start the conversation below.</p>
                        ) : (
                          comments.map((c) => (
                            <div key={c.id || Math.random()} className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-xs">
                              <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                                <span className="font-bold text-slate-700">{c.user_name || "Staff"}</span>
                                <span>{c.created_at ? format(parseISO(c.created_at), "dd MMM, hh:mm a") : ""}</span>
                              </div>
                              <p className="text-slate-800">{c.text}</p>
                            </div>
                          ))
                        )}
                      </div>

                      <form onSubmit={handleAddComment} className="flex gap-2">
                        <input
                          type="text"
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          placeholder="Type a comment or status update..."
                          className="flex-1 px-3 py-2 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#1F6FB2]"
                        />
                        <button
                          type="submit"
                          disabled={submittingComment || !commentText.trim()}
                          className="px-3 py-2 rounded-xl bg-[#0D3B66] text-white text-xs font-bold hover:bg-[#1F6FB2] transition disabled:opacity-50"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
