    narration: '',
  });

  // Chart and breakdown data
  const [chartData, setChartData] = useState([]);
  const [expenseBreakdown, setExpenseBreakdown] = useState([]);

  // AI Insights & Verification
  const [insights, setInsights] = useState([]);
  const [verifying, setVerifying] = useState(false);
  const [validation, setValidation] = useState(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState(null);

  // Chatbot State
  const [chatMessages, setChatMessages] = useState([
    {
      sender: 'ai',
      text: 'Hello! I am Finix AI, your intelligent financial co-pilot. I have scanned your general ledger, verified debit-credit parity, and reconciled GST/TDS liabilities. How can I assist you with your books today?',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const fetchIdRef = useRef(0);

  const scopeCompanies = (list) => {
    const rows = Array.isArray(list) ? list : [];
    // Platform Owner / non-commercial users must never see commercial-license
    // tenant companies in operational company selectors. Licensee users are
    // separately restricted to their own tenant company below.
    const operational = rows.filter((c) => {
      if (!c || typeof c !== 'object') return false;
      if (tenantCompanyId) return true;
      if (c.source === 'commercial-license' || c.source === 'commercial' || c.source === 'license') return false;
      if (c.commercial_customer_id && c.commercial_customer_id !== 'platform-owner') return false;
      if (c.license_id && c.license_id !== 'platform-owner-license') return false;
      return true;
    });
    if (!tenantCompanyId) return operational;
    const own = operational.filter((c) => c && c.id === tenantCompanyId);
    return own.length ? own : [{ id: tenantCompanyId, name: tenantCompanyName }];
  };

  const fetchCompanies = async () => {
    ensureCacheOwner(user?.id);
    if (_companiesCache_finix.data && Date.now() - _companiesCache_finix.ts < COMPANIES_CACHE_TTL_MS) {
      const scoped = scopeCompanies(_companiesCache_finix.data);
      setCompanies(scoped);
      return scoped;
    }
    const cached = ssRead(SS_COMPANIES_KEY);