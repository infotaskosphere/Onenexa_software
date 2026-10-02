"""
Reconciliation Engine (Phase 8)
Orchestrates automated and manual bank reconciliations. Runs rules matching, fuzzy candidate payments lookup,
updates transaction statuses, triggers double-entry ledger posting, and records audit trails.
"""

import logging
import re
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import uuid

from backend.bank_ai.bank_storage import BankStorage
from backend.bank_ai.payment_matcher import PaymentMatcher
from backend.bank_ai.narration_analyser import NarrationAnalyser
from backend.bank_ai.reconciliation_audit import ReconciliationAudit
from backend.accounting_core import try_auto_post, get_default_account_id

logger = logging.getLogger("reconciliation_engine")

class ReconciliationEngine:
    @classmethod
    async def run_auto_reconciliation(cls, bank_account_id: str, company_id: str, user_id: str) -> Dict[str, Any]:
        """
        Orchestrates auto-reconciliation of all unreconciled transactions for a given bank account.
        1. Fetches active user rules.
        2. Iterates over unreconciled transactions.
        3. Attempts rule matches.
        4. If unmatched, attempts invoice/bill fuzzy pairing.
        5. Logs results, updates statuses, posts double-entry journals.
        """
        stats = {
            "processed": 0,
            "reconciled_by_rules": 0,
            "reconciled_by_matching": 0,
            "failed_or_skipped": 0
        }

        # 1. Fetch unmatched transactions
        unmatched_txns = await BankStorage.get_bank_transactions(
            bank_account_id=bank_account_id,
            status="unreconciled",
            limit=500
        )
        if not unmatched_txns:
            return {"status": "success", "message": "No unreconciled transactions found.", "stats": stats}

        # 2. Fetch active rules
        active_rules = await BankStorage.get_active_rules()

        # 3. Fetch default bank account id in Chart of Accounts for posting
        bank_account_coa_id = await get_default_account_id(company_id, "1010") # 1010 is Bank Accounts in default COA

        for txn in unmatched_txns:
            stats["processed"] += 1
            txn_id = txn["id"]
            narration = txn.get("narration", "")
            amount = float(txn.get("amount", 0.0))
            txn_type = txn.get("type", "debit").lower()
            date_str = txn.get("date")

            reconciled = False

            # --- STRATEGY A: Apply Rules ---
            for rule in active_rules:
                pattern = rule.get("pattern", "")
                if pattern and pattern.lower() in narration.lower():
                    # Rule matches! Auto reconcile
                    category = rule.get("category", "Uncategorized")
                    dest_account_id = rule.get("account_id")
                    
                    recon_id = str(uuid.uuid4())
                    recon_doc = {
                        "id": recon_id,
                        "bank_account_id": bank_account_id,
                        "bank_transaction_id": txn_id,
                        "type": "rule",
                        "rule_id": rule["id"],
                        "category": category,
                        "status": "reconciled"
                    }

                    # Trigger double-entry journal entry posting if accounts are resolved
                    if dest_account_id and bank_account_coa_id:
                        journal_lines = []
                        if txn_type == "credit":
                            # Received money: Debit Bank, Credit destination ledger (e.g. Sales Income/Customer Receipt)
                            journal_lines = [
                                {"account_id": bank_account_coa_id, "debit": amount, "credit": 0.0, "memo": f"Rule Match: {narration}"},
                                {"account_id": dest_account_id, "debit": 0.0, "credit": amount, "memo": f"Rule Match: {narration}"}
                            ]
                        else:
                            # Sent money: Debit destination ledger (e.g. Office Expense), Credit Bank
                            journal_lines = [
                                {"account_id": dest_account_id, "debit": amount, "credit": 0.0, "memo": f"Rule Match: {narration}"},
                                {"account_id": bank_account_coa_id, "debit": 0.0, "credit": amount, "memo": f"Rule Match: {narration}"}
                            ]
                        
                        await try_auto_post(
                            company_id=company_id,
                            entry_date=date_str,
                            narration=f"Bank Auto-Reconciliation: {narration}",
                            lines=journal_lines,
                            source="bank_reconciliation",
                            source_id=recon_id,
                            created_by=user_id
                        )

                    # Save reconciliation record & update txn status
                    await BankStorage.create_reconciliation(recon_doc)
                    await BankStorage.update_bank_transaction_status(txn_id, "reconciled", recon_id)
                    
                    # Log Audit decision
                    await ReconciliationAudit.log_decision(
                        bank_transaction=txn,
                        matched_record_id=None,
                        match_type="rule",
                        confidence=1.0,
                        reasons=[f"Rule '{rule.get('name', 'Unnamed')}' pattern matched narration string."],
                        user_id=user_id
                    )

                    stats["reconciled_by_rules"] += 1
                    reconciled = True
                    break

            if reconciled:
                continue

            # --- STRATEGY B: Fuzzy Payment Matching ---
            candidates = await PaymentMatcher.find_matches(txn)
            if candidates and candidates[0]["score"] >= 85: # High confidence matching threshold
                best_cand = candidates[0]
                recon_id = str(uuid.uuid4())
                recon_doc = {
                    "id": recon_id,
                    "bank_account_id": bank_account_id,
                    "bank_transaction_id": txn_id,
                    "type": "fuzzy",
                    "matched_record_id": best_cand["candidate_id"],
                    "matched_record_type": best_cand["match_type"],
                    "status": "reconciled"
                }

                # Update target record status (invoice or purchase bill)
                from backend.dependencies import db
                if best_cand["match_type"] == "invoice":
                    await db.invoices.update_one(
                        {"id": best_cand["candidate_id"]},
                        {"$set": {"status": "paid", "reconciled_at": datetime.now(timezone.utc).isoformat()}}
                    )
                elif best_cand["match_type"] == "bill":
                    await db.purchases.update_one(
                        {"id": best_cand["candidate_id"]},
                        {"$set": {"status": "paid", "reconciled_at": datetime.now(timezone.utc).isoformat()}}
                    )

                # Post double-entry journal entry to record payment receipt/expense
                if bank_account_coa_id:
                    # Resolve default ledger accounts (Accounts Receivable (1100) or Accounts Payable)
                    ar_coa_id = await get_default_account_id(company_id, "1100")
                    # Fallback or general balance account
                    dest_coa_id = ar_coa_id or bank_account_coa_id # default simple ledger fallback
                    
                    journal_lines = []
                    if txn_type == "credit":
                        journal_lines = [
                            {"account_id": bank_account_coa_id, "debit": amount, "credit": 0.0, "memo": f"Match Ref: {narration}"},
                            {"account_id": dest_coa_id, "debit": 0.0, "credit": amount, "memo": f"Match Ref: {narration}"}
                        ]
                    else:
                        journal_lines = [
                            {"account_id": dest_coa_id, "debit": amount, "credit": 0.0, "memo": f"Match Ref: {narration}"},
                            {"account_id": bank_account_coa_id, "debit": 0.0, "credit": amount, "memo": f"Match Ref: {narration}"}
                        ]

                    await try_auto_post(
                        company_id=company_id,
                        entry_date=date_str,
                        narration=f"Bank Matching Reconciliation: {narration}",
                        lines=journal_lines,
                        source="bank_reconciliation",
                        source_id=recon_id,
                        created_by=user_id
                    )

                await BankStorage.create_reconciliation(recon_doc)
                await BankStorage.update_bank_transaction_status(txn_id, "reconciled", recon_id)

                await ReconciliationAudit.log_decision(
                    bank_transaction=txn,
                    matched_record_id=best_cand["candidate_id"],
                    match_type="fuzzy",
                    confidence=best_cand["confidence"],
                    reasons=best_cand["reasons"],
                    user_id=user_id
                )

                stats["reconciled_by_matching"] += 1
                reconciled = True

            if not reconciled:
                stats["failed_or_skipped"] += 1

        return {
            "status": "success",
            "message": f"Auto-reconciliation run finished. Reconciled {stats['reconciled_by_rules'] + stats['reconciled_by_matching']} transactions.",
            "stats": stats
        }

    @classmethod
    async def manual_reconcile(
        cls,
        bank_transaction_id: str,
        matched_record_id: Optional[str],
        matched_record_type: Optional[str],
        category: Optional[str],
        coa_account_id: Optional[str],
        company_id: str,
        user_id: str
    ) -> Dict[str, Any]:
        """
        Manually reconciles an individual transaction with a user's chosen target or ledger category.
        """
        txn = await db.bank_transaction_history.find_one({"id": bank_transaction_id})
        if not txn:
            return {"status": "error", "message": "Transaction not found."}

        amount = float(txn.get("amount", 0.0))
        txn_type = txn.get("type", "debit").lower()
        date_str = txn.get("date")
        narration = txn.get("narration", "")

        recon_id = str(uuid.uuid4())
        recon_doc = {
            "id": recon_id,
            "bank_account_id": txn.get("bank_account_id"),
            "bank_transaction_id": bank_transaction_id,
            "type": "manual",
            "matched_record_id": matched_record_id,
            "matched_record_type": matched_record_type,
            "category": category or "Manual Entry",
            "status": "reconciled"
        }

        # Handle updating database collection if manually matched
        if matched_record_id and matched_record_type:
            if matched_record_type == "invoice":
                await db.invoices.update_one({"id": matched_record_id}, {"$set": {"status": "paid"}})
            elif matched_record_type == "bill":
                await db.purchases.update_one({"id": matched_record_id}, {"$set": {"status": "paid"}})

        # Double-entry posting if ledger accounts are specified
        bank_account_coa_id = await get_default_account_id(company_id, "1010")
        if coa_account_id and bank_account_coa_id:
            journal_lines = []
            if txn_type == "credit":
                journal_lines = [
                    {"account_id": bank_account_coa_id, "debit": amount, "credit": 0.0, "memo": f"Manual Match: {narration}"},
                    {"account_id": coa_account_id, "debit": 0.0, "credit": amount, "memo": f"Manual Match: {narration}"}
                ]
            else:
                journal_lines = [
                    {"account_id": coa_account_id, "debit": amount, "credit": 0.0, "memo": f"Manual Match: {narration}"},
                    {"account_id": bank_account_coa_id, "debit": 0.0, "credit": amount, "memo": f"Manual Match: {narration}"}
                ]

            await try_auto_post(
                company_id=company_id,
                entry_date=date_str,
                narration=f"Manual Bank Reconciliation: {narration}",
                lines=journal_lines,
                source="bank_reconciliation",
                source_id=recon_id,
                created_by=user_id
            )

        # Record manual reinforcement learning feedback
        if category and narration:
            # Clean narration a bit to create a generic pattern
            pattern = re.sub(r'\d+', '', narration).strip()[:30] # remove numbers/dates
            if len(pattern) > 5:
                await BankStorage.update_reinforcement_feedback(pattern, category, +1)

        await BankStorage.create_reconciliation(recon_doc)
        await BankStorage.update_bank_transaction_status(bank_transaction_id, "reconciled", recon_id)

        # Log audit trail
        await ReconciliationAudit.log_decision(
            bank_transaction=txn,
            matched_record_id=matched_record_id,
            match_type="manual",
            confidence=1.0,
            reasons=["Manually reconciled by user."],
            user_id=user_id
        )

        return {"status": "success", "message": "Transaction manually reconciled."}
