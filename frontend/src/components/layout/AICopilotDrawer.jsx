import React, { useState, useEffect, useRef } from 'react';
import {
  BrainCircuit, Sparkles, X, Send, Paperclip, CheckCheck,
  CheckCircle2, FileText, Users, BarChart3, Search,
  Landmark, ShieldCheck, Maximize2, Minimize2, Settings, User,
  Loader2, Lightbulb
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import api from '@/lib/api';

const getTimeString = () => {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function AICopilotDrawer({ isOpen, onClose, isDark, user }) {
  const firstName = user?.full_name?.split(' ')[0] || 'Manthan';
  const initialTime = useRef(getTimeString()).current;

  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      time: initialTime,
      type: 'greeting',
      content: `Hi ${firstName} 👋\nI'm AI Search. I can help with tasks, compliance, bank transactions and accounts.`
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  const handleSend = async (e, directText) => {
    if (e) e.preventDefault();
    const queryText = (directText || input).trim();
    if (!queryText || loading) return;

    const userTime = getTimeString();
    setInput('');
    setMessages(prev => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        time: userTime,
        content: queryText
      }
    ]);
    setLoading(true);

    try {
      const { data } = await api.post('/v2/copilot/chat', { query: queryText });
      const replyText = data?.reply || data?.response || data?.message || (typeof data === 'string' ? data : '');
      const toolData = data?.tool_data;
      const matchedTool = data?.matched_tool;
      const respTime = getTimeString();

      // Determine rich card representation matching exact screenshot designs
      let cardType = 'standard';
      let snapshotData = null;
      let invoicesData = null;

      const lowerQuery = queryText.toLowerCase();
      const lowerReply = (replyText || '').toLowerCase();

      if (
        lowerQuery.includes('unpaid') ||
        lowerQuery.includes('payment') ||
        lowerQuery.includes('outstanding') ||
        toolData?.type === 'OUTSTANDING_PAYMENTS'
      ) {
        if (toolData?.count === 0 || lowerReply.includes('no unpaid') || lowerReply.includes('settled')) {
          cardType = 'no_unpaid_bills';
        } else if (toolData && toolData.invoices && toolData.invoices.length > 0) {
          cardType = 'invoices_list';
          invoicesData = toolData;
        }
      }

      if (
        lowerQuery.includes('audit bank') ||
        lowerQuery.includes('snapshot') ||
        lowerQuery.includes('workspace') ||
        lowerReply.includes('workspace snapshot') ||
        lowerReply.includes('here is what i found in your workspace')
      ) {
        cardType = 'workspace_snapshot';
        // Parse counts if available, or extract from response
        const invMatch = lowerReply.match(/invoices:?\*?\*?\s*(\d+)/i);
        const taskMatch = lowerReply.match(/tasks:?\*?\*?\s*(\d+)/i);
        const clientMatch = lowerReply.match(/clients:?\*?\*?\s*(\d+)/i);

        snapshotData = {
          invoices: invMatch ? parseInt(invMatch[1], 10) : (toolData?.count || 0),
          tasks: taskMatch ? parseInt(taskMatch[1], 10) : 0,
          clients: clientMatch ? parseInt(clientMatch[1], 10) : 0
        };
      }

      setMessages(prev => [
        ...prev,
        {
          id: `bot-${Date.now()}`,
          role: 'assistant',
          time: respTime,
          type: cardType,
          content: replyText || `Taskosphere AI Search processed your request: "${queryText}".`,
          snapshotData,
          invoicesData
        }
      ]);
    } catch {
      setTimeout(() => {
        setMessages(prev => [
          ...prev,
          {
            id: `bot-${Date.now()}`,
            role: 'assistant',
            time: getTimeString(),
            type: 'standard',
            content: `Sorry, I couldn't process "${queryText}" right now. Please try again in a moment.`
          }
        ]);
      }, 700);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex justify-end">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className={`relative h-full flex flex-col border-l shadow-2xl transition-all duration-300 ease-in-out ${
          isExpanded ? 'w-full max-w-[720px]' : 'w-full max-w-[490px]'
        } ${isDark ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}
      >
        {/* Header matching Image 1 */}
        <div
          className="p-4 px-5 border-b flex items-center justify-between flex-shrink-0"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-100 dark:border-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 shadow-sm">
              <BrainCircuit className="h-5 w-5" strokeWidth={2.2} />
            </div>
            <div>
              <h3 className={`font-bold text-sm tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                AI Search
              </h3>
              <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-[2px] bg-emerald-500" /> Workspace Active
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIsExpanded(prev => !prev)}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title={isExpanded ? 'Collapse Drawer' : 'Expand Drawer'}
            >
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => toast.info('AI Copilot connected with Gemini Enterprise Search')}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title="Copilot Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Message Area */}
        <div className="flex-1 overflow-y-auto p-4 px-5 space-y-5 slim-scroll">
          {messages.map((m) => {
            const isUser = m.role === 'user';

            if (isUser) {
              return (
                <div key={m.id} className="flex flex-col items-end max-w-[85%] ml-auto">
                  <div className="flex items-end gap-2.5">
                    <div
                      className={`p-3 px-4 rounded-2xl rounded-tr-sm text-xs sm:text-sm font-medium shadow-sm leading-relaxed ${
                        isDark
                          ? 'bg-blue-950/80 border border-blue-900/70 text-blue-100'
                          : 'bg-[#EEF4FF] border border-blue-100/90 text-blue-950'
                      }`}
                    >
                      {m.content}
                    </div>
                    <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center flex-shrink-0 shadow-sm">
                      <User className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400 font-medium flex items-center gap-1 mt-1 pr-10">
                    <span>{m.time}</span>
                    <CheckCheck className="h-3 w-3 text-blue-500" />
                  </div>
                </div>
              );
            }

            // Assistant messages with sparkle avatar
            return (
              <div key={m.id} className="flex items-start gap-3 max-w-[92%] mr-auto">
                <div className="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/40 border border-blue-100 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5 shadow-xs">
                  <Sparkles className="h-4 w-4 fill-blue-500/20" />
                </div>

                <div className="flex-1 min-w-0">
                  {/* Card Type: Greeting */}
                  {m.type === 'greeting' && (
                    <div
                      className={`p-4 rounded-2xl rounded-tl-sm text-xs sm:text-sm leading-relaxed shadow-xs ${
                        isDark
                          ? 'bg-slate-800/80 border border-slate-700/60 text-slate-200'
                          : 'bg-[#F8FAFC] border border-slate-150 text-slate-800'
                      }`}
                    >
                      <p className="font-semibold text-slate-900 dark:text-white">
                        Hi {firstName} 👋
                      </p>
                      <p className="mt-1 text-slate-700 dark:text-slate-300">
                        I'm AI Search.{' '}
                        <strong className="font-bold text-slate-900 dark:text-white">
                          I can help with tasks, compliance, bank transactions and accounts.
                        </strong>
                      </p>
                    </div>
                  )}

                  {/* Card Type: No Unpaid Customer Bills (Exact design from Image 1) */}
                  {m.type === 'no_unpaid_bills' && (
                    <div
                      className={`p-4 rounded-2xl rounded-tl-sm border shadow-xs flex items-start gap-3.5 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                    >
                      <div className="w-7 h-7 rounded-full bg-emerald-500/10 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-slate-100">
                          No unpaid customer bills found.
                        </h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          All customer payments and bills are fully settled.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Card Type: Workspace Snapshot (Exact design from Image 1) */}
                  {m.type === 'workspace_snapshot' && (
                    <div
                      className={`p-4 rounded-2xl rounded-tl-sm border shadow-xs space-y-3.5 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                    >
                      {/* Header */}
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex-shrink-0">
                          <BarChart3 className="h-5 w-5" />
                        </div>
                        <div>
                          <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-slate-100">
                            Workspace snapshot
                          </h4>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Here's what I found in your workspace:
                          </p>
                        </div>
                      </div>

                      {/* 3 Metric Cards Grid */}
                      <div className="grid grid-cols-3 gap-2.5">
                        {/* Invoices */}
                        <div
                          className={`rounded-xl p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-blue-950/30 border-blue-900/40 text-blue-100'
                              : 'bg-blue-50/60 border-blue-100/90 text-blue-950'
                          }`}
                        >
                          <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400 mb-1" />
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            Invoices
                          </span>
                          <span className="text-xl font-bold text-slate-900 dark:text-white my-0.5">
                            {m.snapshotData?.invoices ?? 0}
                          </span>
                          <span className="text-[10px] text-slate-400 font-medium">Pending</span>
                        </div>

                        {/* Tasks */}
                        <div
                          className={`rounded-xl p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-emerald-950/30 border-emerald-900/40 text-emerald-100'
                              : 'bg-emerald-50/60 border-emerald-100/90 text-emerald-950'
                          }`}
                        >
                          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mb-1" />
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            Tasks
                          </span>
                          <span className="text-xl font-bold text-slate-900 dark:text-white my-0.5">
                            {m.snapshotData?.tasks ?? 0}
                          </span>
                          <span className="text-[10px] text-slate-400 font-medium">Active</span>
                        </div>

                        {/* Clients */}
                        <div
                          className={`rounded-xl p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-orange-950/30 border-orange-900/40 text-orange-100'
                              : 'bg-orange-50/60 border-orange-100/90 text-orange-950'
                          }`}
                        >
                          <Users className="h-5 w-5 text-orange-600 dark:text-orange-400 mb-1" />
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            Clients
                          </span>
                          <span className="text-xl font-bold text-slate-900 dark:text-white my-0.5">
                            {m.snapshotData?.clients ?? 0}
                          </span>
                          <span className="text-[10px] text-slate-400 font-medium">Registered</span>
                        </div>
                      </div>

                      {/* Footer Tip */}
                      <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                        <span className="text-amber-500">💡</span>
                        <span>Ask me to search clients, GST returns or pending tasks.</span>
                      </div>
                    </div>
                  )}

                  {/* Card Type: Invoices List */}
                  {m.type === 'invoices_list' && (
                    <div
                      className={`p-4 rounded-2xl rounded-tl-sm border shadow-xs space-y-3 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                    >
                      <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                        <div>
                          <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-slate-100">
                            Outstanding Invoices ({m.invoicesData?.count || 0})
                          </h4>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            Total pending: ₹{(m.invoicesData?.total_outstanding || 0).toLocaleString('en-IN')}
                          </p>
                        </div>
                      </div>
                      <div className="space-y-2 max-h-56 overflow-y-auto slim-scroll">
                        {m.invoicesData?.invoices?.map((inv, idx) => (
                          <div
                            key={idx}
                            className={`p-2.5 rounded-xl border flex items-center justify-between text-xs ${
                              isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200'
                            }`}
                          >
                            <div className="min-w-0 pr-2">
                              <p className="font-bold truncate text-slate-800 dark:text-slate-200">
                                {inv.invoice_no || `INV-${idx + 1}`} · {inv.client_name}
                              </p>
                              <p className="text-[10px] text-slate-400">Due: {inv.due_date || 'N/A'}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <span className="font-bold text-blue-600 dark:text-blue-400">
                                ₹{Number(inv.amount || 0).toLocaleString('en-IN')}
                              </span>
                              <span className="block text-[9px] uppercase font-semibold text-amber-500">
                                {inv.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Standard Message */}
                  {m.type === 'standard' && (
                    <div
                      className={`p-4 rounded-2xl rounded-tl-sm text-xs sm:text-sm leading-relaxed whitespace-pre-wrap shadow-xs ${
                        isDark
                          ? 'bg-slate-800/80 border border-slate-700/60 text-slate-200'
                          : 'bg-[#F8FAFC] border border-slate-150 text-slate-800'
                      }`}
                    >
                      {m.content}
                    </div>
                  )}

                  {/* Timestamp below message */}
                  <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-1 ml-1">
                    {m.time}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex items-center gap-3 text-slate-400 text-xs font-semibold py-2">
              <div className="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/40 border border-blue-100 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
              <span>AI Search analyzing workspace data...</span>
            </div>
          )}

          <div ref={scrollRef} />
        </div>

        {/* Suggestion Pills matching Image 1 */}
        <div
          className="p-3 px-5 border-t flex items-center gap-2 overflow-x-auto slim-scroll"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <button
            type="button"
            onClick={() => handleSend(null, 'Find unpaid bills')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
          >
            <Search className="h-3.5 w-3.5 text-blue-500" />
            Find Unpaid Bills
          </button>

          <button
            type="button"
            onClick={() => handleSend(null, 'Audit bank entries and workspace snapshot')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
          >
            <Landmark className="h-3.5 w-3.5 text-blue-500" />
            Audit <span className="text-blue-500 font-bold">Bank Entries</span>
          </button>

          <button
            type="button"
            onClick={() => handleSend(null, 'Verify GST ITC reconciliation status')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />
            Verify GST ITC
          </button>
        </div>

        {/* Bottom Input Area matching Image 1 */}
        <form
          onSubmit={handleSend}
          className="p-3 px-5 border-t"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <div
            className={`flex items-center rounded-2xl border p-1.5 pl-4 gap-2 transition-all shadow-xs ${
              isDark
                ? 'bg-slate-950 border-slate-700/80 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500'
                : 'bg-white border-slate-200 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500'
            }`}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search or ask AI anything..."
              className="flex-1 bg-transparent border-none outline-none text-xs sm:text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={() => toast.info('Document and voucher attachment ready')}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors cursor-pointer"
              title="Attach document or invoice"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:scale-100 text-white flex items-center justify-center shadow-md transition-all cursor-pointer flex-shrink-0"
              title="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
