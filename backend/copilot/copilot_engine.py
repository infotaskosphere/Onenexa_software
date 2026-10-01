import logging
from typing import Dict, Any, Optional
from datetime import datetime, timezone
import uuid
from backend.dependencies import db
from backend.copilot.prompt_manager import PromptManager
from backend.copilot.context_manager import ContextManager
from backend.copilot.copilot_permissions import CopilotPermissions
from backend.copilot.copilot_audit import CopilotAudit
from backend.copilot.conversation_manager import ConversationManager
from backend.copilot.tool_router import ToolRouter
from backend.copilot.reasoning_engine import ReasoningEngine

logger = logging.getLogger("copilot_engine")

class CopilotEngine:
    @staticmethod
    async def process_copilot_request(
        user: Any,
        session_id: Optional[str],
        query: str,
        role_preset: str = "assistant"
    ) -> Dict[str, Any]:
        """Runs the complete Copilot pipeline: Perms -> Tools -> Context -> Prompt -> LLM Reasoning -> Audit."""
        user_id = getattr(user, "id", "system")
        company_id = getattr(user, "company_id", "default_comp")
        tenant_id = getattr(user, "tenant_id", "default_tenant")
        
        # 1. Verify general financial permission if querying financials
        if any(w in query.lower() for w in ["balance sheet", "profit", "ledger", "financial", "cash flow"]):
            CopilotPermissions.assert_can_query_financials(user)

        # 2. Match background tool using natural language
        matched_tool = await ToolRouter.match_tool(query, company_id)
        tool_data = None
        if matched_tool:
            logger.info(f"Matched tool for query: {matched_tool}")
            tool_data = await ToolRouter.execute_matched_tool(matched_tool)
            
        # 3. Retrieve chat session or start a new one
        if not session_id:
            session = await ConversationManager.create_session(user_id, company_id, title=query[:30])
            session_id = session["id"]
        else:
            session = await ConversationManager.get_session(session_id)
            if not session:
                session = await ConversationManager.create_session(user_id, company_id, title=query[:30])
                session_id = session["id"]

        # Append user message to history
        await ConversationManager.append_message(session_id, "user", query)

        # 4. Gather active tenant context details
        context_info = await ContextManager.gather_user_context(company_id, tenant_id)
        if tool_data:
            context_info["tool_results"] = tool_data

        # 5. Formulate prompt using PromptManager
        system_instruction = PromptManager.get_system_prompt(role_preset, str(context_info))
        
        # 6. Call provider-agnostic reasoning model
        reasoning_result = await ReasoningEngine.get_response(
            prompt=query,
            system_instruction=system_instruction,
            context_data=context_info
        )
        response_text = reasoning_result["text"]

        # Append assistant message to history
        await ConversationManager.append_message(session_id, "assistant", response_text)

        # 7. Immutably log metrics and trace to copilot audit database
        tokens_used = reasoning_result.get("tokens", len(query + response_text) // 4)
        await CopilotAudit.log_copilot_interaction(
            user_id=user_id,
            company_id=company_id,
            session_id=session_id,
            query=query,
            response=response_text,
            matched_tools=[matched_tool] if matched_tool else [],
            tokens_used=tokens_used
        )

        return {
            "session_id": session_id,
            "response": response_text,
            "matched_tool": matched_tool,
            "tool_data": tool_data,
            "provider_used": reasoning_result.get("provider"),
            "model_used": reasoning_result.get("model")
        }
