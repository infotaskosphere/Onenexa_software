import React, { useState, useEffect, useRef } from 'react';
import {
  BrainCircuit, Sparkles, X, Send, Paperclip, CheckCheck,
  CheckCircle2, FileText, Users, BarChart3, Search,
  Landmark, ShieldCheck, Maximize2, Minimize2, Settings, User,
  Loader2, Lightbulb, AlertCircle, ArrowUpRight
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import api from '@/lib/api';
import '@/ai-copilot-drawer.css';

const getTimeString = () => {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Helper to render markdown bold and bullets cleanly without raw asterisks
function FormattedText({ text, isDark }) {
  if (!text) return null;

  // Split into lines
  const lines = text.split('\n');

  return (
    <div className="space-y-1.5 text-xs sm:text-[13px] leading-relaxed">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={idx} className="h-1" />;

        // Tip callout
        if (trimmed.toLowerCase().startsWith('tip:')) {
          const tipContent = trimmed.slice(4).trim();
          return (
            <div
              key={idx}
              className={`mt-2 p-2.5 rounded-xl border flex items-start gap-2 ${
                isDark
                  ? 'bg-blue-950/40 border-blue-900/50 text-blue-200'
                  : 'bg-blue-50/70 border-blue-100 text-blue-900'
              }`}
              style={{ borderRadius: '12px' }}
            >
              <Lightbulb className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="font-bold mr-1">Tip:</span>
                <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(tipContent) }} />
              </div>
            </div>
          );
        }

        // Bullet line
        if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('* ')) {
          const bulletText = trimmed.replace(/^[•\-*]\s*/, '');
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />
              <div
                className="flex-1 min-w-0"
                dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(bulletText) }}
              />
            </div>
          );
        }

        // Regular line with inline formatting
        return (
          <div
            key={idx}
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed) }}
          />
        );
      })}
    </div>
  );
}

// Convert **bold** to <strong>
function renderInlineMarkdown(str) {
  if (!str) return '';
  return str.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-slate-100">$1</strong>');
}

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
      const respTime = getTimeString();

      const lowerQuery = queryText.toLowerCase();
      const lowerReply = (replyText || '').toLowerCase();

      // Determine the optimal card representation
      let cardType = 'standard';
      let snapshotData = null;
      let invoicesData = null;
      let clientCount = 0;

      // 1. Unpaid bills check
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

      // 2. GST & Returns query
      else if (
        lowerQuery.includes('gst') ||
        lowerQuery.includes('itc') ||
        lowerQuery.includes('tax return') ||
        toolData?.type === 'GST_FILINGS' ||
        lowerReply.includes('gst compliance')
      ) {
        cardType = 'gst_status';
      }

      // 3. Client directory query
      else if (
        lowerQuery.includes('client') ||
        lowerQuery.includes('customer') ||
        toolData?.type === 'CLIENT_LIST' ||
        lowerReply.includes('registered client')
      ) {
        cardType = 'clients_status';
        const clientMatch = lowerReply.match(/(\d+)\s*registered client/i);
        clientCount = clientMatch ? parseInt(clientMatch[1], 10) : (toolData?.count || 0);
      }

      // 4. Workspace snapshot or Bank Audit
      else if (
        lowerQuery.includes('audit bank') ||
        lowerQuery.includes('snapshot') ||
        lowerQuery.includes('workspace') ||
        lowerReply.includes('workspace snapshot') ||
        lowerReply.includes('here is what i found in your workspace')
      ) {
        cardType = 'workspace_snapshot';
        const invMatch = lowerReply.match(/invoices:?\*?\*?\s*(\d+)/i);
        const taskMatch = lowerReply.match(/tasks:?\*?\*?\s*(\d+)/i);
        const clMatch = lowerReply.match(/clients:?\*?\*?\s*(\d+)/i);

        snapshotData = {
          invoices: invMatch ? parseInt(invMatch[1], 10) : (toolData?.count || 0),
          tasks: taskMatch ? parseInt(taskMatch[1], 10) : 0,
          clients: clMatch ? parseInt(clMatch[1], 10) : 0
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
          invoicesData,
          clientCount
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
    <div id="ai-search-drawer" data-ai-drawer="true" className="fixed inset-0 z-[250] flex justify-end">
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
        {/* Header */}
        <div
          className="p-4 px-5 border-b flex items-center justify-between flex-shrink-0"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="ai-header-icon w-8 h-8 flex items-center justify-center bg-blue-50 dark:bg-blue-950/60 border border-blue-100 dark:border-blue-900/50 text-blue-600 dark:text-blue-400 shadow-sm"
              style={{ borderRadius: '10px' }}
            >
              <BrainCircuit className="h-5 w-5" strokeWidth={2.2} />
            </div>
            <div>
              <h3 className={`font-bold text-sm tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                AI Search
              </h3>
              <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 bg-emerald-500 inline-block" style={{ borderRadius: '2px' }} /> Workspace Active
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
                      className={`ai-user-bubble p-3 px-4 text-xs sm:text-sm font-medium shadow-sm leading-relaxed ${
                        isDark
                          ? 'bg-blue-950/80 border border-blue-900/70 text-blue-100'
                          : 'bg-[#EEF4FF] border border-blue-100/90 text-blue-950'
                      }`}
                      style={{ borderRadius: '18px 4px 18px 18px' }}
                    >
                      {m.content}
                    </div>
                    <div
                      className="ai-user-avatar w-8 h-8 bg-blue-600 text-white flex items-center justify-center flex-shrink-0 shadow-sm"
                      style={{ borderRadius: '9999px' }}
                    >
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

            // Assistant messages
            return (
              <div key={m.id} className="flex items-start gap-3 max-w-[92%] mr-auto">
                <div
                  className="ai-bot-avatar w-8 h-8 bg-blue-50 dark:bg-blue-900/40 border border-blue-100 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5 shadow-xs"
                  style={{ borderRadius: '9999px' }}
                >
                  <Sparkles className="h-4 w-4 fill-blue-500/20" />
                </div>

                <div className="flex-1 min-w-0">
                  {/* Card Type: Greeting */}
                  {m.type === 'greeting' && (
                    <div
                      className={`ai-bot-bubble p-4 text-xs sm:text-sm leading-relaxed shadow-xs ${
                        isDark
                          ? 'bg-slate-800/80 border border-slate-700/60 text-slate-200'
                          : 'bg-[#F8FAFC] border border-slate-200/80 text-slate-800'
                      }`}
                      style={{ borderRadius: '4px 18px 18px 18px' }}
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

                  {/* Card Type: No Unpaid Customer Bills (Exact from reference design) */}
                  {m.type === 'no_unpaid_bills' && (
                    <div
                      className={`ai-card-surface p-4 border shadow-xs flex items-start gap-3.5 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                      style={{ borderRadius: '16px' }}
                    >
                      <div
                        className="w-7 h-7 bg-emerald-500/10 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ borderRadius: '9999px' }}
                      >
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

                  {/* Card Type: GST Status & ITC */}
                  {m.type === 'gst_status' && (
                    <div
                      className={`ai-card-surface p-4 border shadow-xs space-y-3 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                      style={{ borderRadius: '16px' }}
                    >
                      <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100 dark:border-slate-800">
                        <div
                          className="p-1.5 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400"
                          style={{ borderRadius: '8px' }}
                        >
                          <ShieldCheck className="h-4 w-4" />
                        </div>
                        <div>
                          <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-slate-100">
                            GST Compliance &amp; Returns Status
                          </h4>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            Active tax period reconciliation
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div
                          className={`p-2.5 rounded-xl border flex items-center justify-between text-xs ${
                            isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50/80 border-slate-200/70'
                          }`}
                          style={{ borderRadius: '10px' }}
                        >
                          <div>
                            <span className="font-bold text-slate-800 dark:text-slate-200">GSTR-1</span>
                            <span className="text-slate-500 text-[11px] ml-2">Sales Outward Supply</span>
                          </div>
                          <span
                            className="px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                            style={{ borderRadius: '9999px' }}
                          >
                            Ready / Filed
                          </span>
                        </div>

                        <div
                          className={`p-2.5 rounded-xl border flex items-center justify-between text-xs ${
                            isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50/80 border-slate-200/70'
                          }`}
                          style={{ borderRadius: '10px' }}
                        >
                          <div>
                            <span className="font-bold text-slate-800 dark:text-slate-200">GSTR-3B</span>
                            <span className="text-slate-500 text-[11px] ml-2">Monthly Tax Return</span>
                          </div>
                          <span
                            className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                            style={{ borderRadius: '9999px' }}
                          >
                            Pending Filing
                          </span>
                        </div>

                        <div
                          className={`p-2.5 rounded-xl border flex items-center justify-between text-xs ${
                            isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50/80 border-slate-200/70'
                          }`}
                          style={{ borderRadius: '10px' }}
                        >
                          <div>
                            <span className="font-bold text-slate-800 dark:text-slate-200">GSTR-2B ITC Match</span>
                            <span className="text-slate-500 text-[11px] ml-2">Purchase Reconciliation</span>
                          </div>
                          <span
                            className="px-2 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                            style={{ borderRadius: '9999px' }}
                          >
                            99.8% Matched
                          </span>
                        </div>
                      </div>

                      <div
                        className="p-2.5 rounded-xl border bg-blue-50/60 dark:bg-blue-950/30 border-blue-100 dark:border-blue-900/40 text-[11px] text-blue-900 dark:text-blue-200 flex items-center gap-2"
                        style={{ borderRadius: '10px' }}
                      >
                        <Lightbulb className="h-4 w-4 text-amber-500 flex-shrink-0" />
                        <span>Navigate to <strong>Finix → GST Reconciliation</strong> for invoice-level matching.</span>
                      </div>
                    </div>
                  )}

                  {/* Card Type: Client Directory */}
                  {m.type === 'clients_status' && (
                    <div
                      className={`ai-card-surface p-4 border shadow-xs space-y-3 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                      style={{ borderRadius: '16px' }}
                    >
                      <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100 dark:border-slate-800">
                        <div
                          className="p-1.5 bg-orange-50 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400"
                          style={{ borderRadius: '8px' }}
                        >
                          <Users className="h-4 w-4" />
                        </div>
                        <div>
                          <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-slate-100">
                            Client Directory
                          </h4>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            Registered corporate &amp; individual accounts
                          </p>
                        </div>
                      </div>

                      <div
                        className={`p-3 border flex items-center justify-between ${
                          isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-orange-50/50 border-orange-100/90'
                        }`}
                        style={{ borderRadius: '12px' }}
                      >
                        <div>
                          <span className="text-2xl font-bold text-slate-900 dark:text-white">
                            {m.clientCount ?? 0}
                          </span>
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 ml-2">
                            Registered Clients
                          </span>
                        </div>
                        <span
                          className="px-2.5 py-1 text-[11px] font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 shadow-xs"
                          style={{ borderRadius: '9999px' }}
                        >
                          Active Master
                        </span>
                      </div>

                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Ask me to search a specific client by name, PAN, DIN, or GSTIN to see assigned compliances and open tasks.
                      </p>
                    </div>
                  )}

                  {/* Card Type: Workspace Snapshot */}
                  {m.type === 'workspace_snapshot' && (
                    <div
                      className={`ai-card-surface p-4 border shadow-xs space-y-3.5 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                      style={{ borderRadius: '16px' }}
                    >
                      {/* Header */}
                      <div className="flex items-start gap-3">
                        <div
                          className="p-2 bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex-shrink-0"
                          style={{ borderRadius: '10px' }}
                        >
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
                        <div
                          className={`ai-metric-card p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-blue-950/30 border-blue-900/40 text-blue-100'
                              : 'bg-blue-50/60 border-blue-100/90 text-blue-950'
                          }`}
                          style={{ borderRadius: '12px' }}
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

                        <div
                          className={`ai-metric-card p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-emerald-950/30 border-emerald-900/40 text-emerald-100'
                              : 'bg-emerald-50/60 border-emerald-100/90 text-emerald-950'
                          }`}
                          style={{ borderRadius: '12px' }}
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

                        <div
                          className={`ai-metric-card p-3 flex flex-col items-center justify-center text-center border ${
                            isDark
                              ? 'bg-orange-950/30 border-orange-900/40 text-orange-100'
                              : 'bg-orange-50/60 border-orange-100/90 text-orange-950'
                          }`}
                          style={{ borderRadius: '12px' }}
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

                      <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                        <span className="text-amber-500">💡</span>
                        <span>Ask me to search clients, GST returns or pending tasks.</span>
                      </div>
                    </div>
                  )}

                  {/* Card Type: Invoices List */}
                  {m.type === 'invoices_list' && (
                    <div
                      className={`ai-card-surface p-4 border shadow-xs space-y-3 ${
                        isDark ? 'bg-slate-800/90 border-slate-700' : 'bg-white border-slate-200/90'
                      }`}
                      style={{ borderRadius: '16px' }}
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
                            className={`p-2.5 border flex items-center justify-between text-xs ${
                              isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200'
                            }`}
                            style={{ borderRadius: '10px' }}
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

                  {/* Standard Message Formatted */}
                  {m.type === 'standard' && (
                    <div
                      className={`ai-bot-bubble p-4 text-xs sm:text-sm leading-relaxed shadow-xs ${
                        isDark
                          ? 'bg-slate-800/80 border border-slate-700/60 text-slate-200'
                          : 'bg-[#F8FAFC] border border-slate-200/80 text-slate-800'
                      }`}
                      style={{ borderRadius: '4px 18px 18px 18px' }}
                    >
                      <FormattedText text={m.content} isDark={isDark} />
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
              <div
                className="ai-bot-avatar w-8 h-8 bg-blue-50 dark:bg-blue-900/40 border border-blue-100 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400"
                style={{ borderRadius: '9999px' }}
              >
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
              <span>AI Search analyzing workspace data...</span>
            </div>
          )}

          <div ref={scrollRef} />
        </div>

        {/* Suggestion Pills */}
        <div
          className="p-3 px-5 border-t flex items-center gap-2 overflow-x-auto slim-scroll"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <button
            type="button"
            onClick={() => handleSend(null, 'Find unpaid bills')}
            className={`ai-pill-btn px-3.5 py-1.5 text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
            style={{ borderRadius: '9999px' }}
          >
            <Search className="h-3.5 w-3.5 text-blue-500" />
            Find Unpaid Bills
          </button>

          <button
            type="button"
            onClick={() => handleSend(null, 'Audit bank entries and workspace snapshot')}
            className={`ai-pill-btn px-3.5 py-1.5 text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
            style={{ borderRadius: '9999px' }}
          >
            <Landmark className="h-3.5 w-3.5 text-blue-500" />
            Audit <span className="text-blue-500 font-bold">Bank Entries</span>
          </button>

          <button
            type="button"
            onClick={() => handleSend(null, 'Verify GST ITC reconciliation status')}
            className={`ai-pill-btn px-3.5 py-1.5 text-xs font-semibold border transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs ${
              isDark
                ? 'border-blue-900/80 bg-slate-900 text-blue-400 hover:bg-blue-950/60'
                : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50/80'
            }`}
            style={{ borderRadius: '9999px' }}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />
            Verify GST ITC
          </button>
        </div>

        {/* Bottom Input Area */}
        <form
          onSubmit={handleSend}
          className="p-3 px-5 border-t"
          style={{ borderColor: isDark ? '#1e293b' : '#f1f5f9' }}
        >
          <div
            className={`ai-input-pill flex items-center border p-1.5 pl-4 gap-2 transition-all shadow-xs ${
              isDark
                ? 'bg-slate-950 border-slate-700/80 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500'
                : 'bg-white border-slate-200 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500'
            }`}
            style={{ borderRadius: '20px' }}
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
              className="ai-send-btn w-9 h-9 bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:scale-100 text-white flex items-center justify-center shadow-md transition-all cursor-pointer flex-shrink-0"
              style={{ borderRadius: '12px' }}
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
