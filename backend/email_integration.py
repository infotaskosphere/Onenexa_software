import os
import imaplib
import email
import email.header
import email.utils
import re
import json
import asyncio
import logging
import html
import difflib
import uuid as _uuid
from html.parser import HTMLParser
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Set, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from bson import ObjectId

from backend.dependencies import get_current_user, db, check_module_permission, get_team_user_ids

_EMAIL_ENCRYPTION_PRODUCTION = str(os.environ.get("ENV_MODE") or "").strip().lower() == "production"
try:
    from cryptography.fernet import Fernet
    import os as _os
    _fernet_key = _os.environ.get("EMAIL_ENCRYPT_KEY", "").encode()
    _fernet = Fernet(_fernet_key) if len(_fernet_key) == 44 else None
    if _EMAIL_ENCRYPTION_PRODUCTION and _fernet is None:
        raise RuntimeError(
            "EMAIL_ENCRYPT_KEY must be configured with a valid Fernet key in production."
        )
except Exception:
    if _EMAIL_ENCRYPTION_PRODUCTION:
        raise
    _fernet = None

try:
    import google.generativeai as genai
    import os as _os2