"""Startup-safe route facade for the complete Finix agent.

The actual implementation imports the existing Finix accounting router lazily
inside request handlers so server.py can import learning_router without a
party-ledger/accounting-router circular import.
"""
from typing import Optional
from fastapi import APIRouter, Depends, File, UploadFile
from backend.dependencies import get_current_user
from backend.models import User

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Agent"])

@router.post("/agent/propose")
async def agent_propose(payload: dict, current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import AgentProposalRequest, agent_propose as impl
    return await impl(AgentProposalRequest(**payload), current_user)

@router.post("/feedback")
async def agent_feedback(payload: dict, current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import FeedbackRequest, agent_feedback as impl
    return await impl(FeedbackRequest(**payload), current_user)

@router.get("/inbox")
async def agent_inbox(company_id: str = "", current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_inbox as impl
    return await impl(company_id, current_user)

@router.post("/inbox/action")
async def agent_inbox_action(payload: dict, current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import InboxActionRequest, agent_inbox_action as impl
    return await impl(InboxActionRequest(**payload), current_user)

@router.post("/upload")
async def agent_upload(file: UploadFile = File(...), company_id: str = "", accounting_date: Optional[str] = None, current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_upload as impl
    return await impl(file, company_id, accounting_date, current_user)

@router.post("/ask")
async def agent_ask(payload: dict, current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import AskRequest, agent_ask as impl
    return await impl(AskRequest(**payload), current_user)

@router.get("/health-score")
async def agent_health_score(company_id: str = "", current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_health_score as impl
    return await impl(company_id, current_user)

@router.get("/statutory-summary")
async def agent_statutory_summary(company_id: str = "", current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_statutory_summary as impl
    return await impl(company_id, current_user)

@router.get("/anomalies")
async def agent_anomalies(company_id: str = "", current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_anomalies as impl
    return await impl(company_id, current_user)

@router.get("/cashflow-forecast")
async def agent_cashflow_forecast(company_id: str = "", current_user: User = Depends(get_current_user)):
    from backend.accounting_ai.finix_agent_complete import agent_cashflow_forecast as impl
    return await impl(company_id, current_user)
