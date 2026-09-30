import api from '@/lib/api';

/**
 * Single client entry point for manual Journal Entry posting.
 *
 * Both Finix Dashboard quick vouchers and the full Journal Entries page use
 * this helper, which guarantees they post to the same backend endpoint and
 * therefore the same journal_entries / journal_lines collections.
 */
export async function createJournalEntry(payload) {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const normalizedLines = lines.map((line) => ({
    account_id: line?.account_id,
    account_name: line?.account_name || '',
    debit: Number(line?.debit || 0),
    credit: Number(line?.credit || 0),
    memo: line?.memo || '',
  }));

  return api.post('/journal-entries', {
    company_id: payload?.company_id || '',
    entry_date: payload?.entry_date,
    narration: String(payload?.narration || '').trim(),
    lines: normalizedLines,
  });
}
