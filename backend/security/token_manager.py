import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
import jwt
from backend.dependencies import JWT_SECRET, ALGORITHM

logger = logging.getLogger("token_manager")

class TokenManager:
    @staticmethod
    def generate_token(user_id: str, extra_payload: Optional[Dict[str, Any]] = None) -> str:
        """Creates standard secure JWT tokens for user authentication."""
        to_encode = {"sub": user_id}
        if extra_payload:
            to_encode.update(extra_payload)
            
        expire = datetime.now(timezone.utc) + timedelta(minutes=1440) # 24 Hours
        to_encode.update({"exp": expire})
        
        encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm=ALGORITHM)
        return encoded_jwt

    @staticmethod
    def verify_token(token: str) -> Optional[Dict[str, Any]]:
        """Verifies JWT token integrity and validity."""
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
            return payload
        except jwt.InvalidTokenError as e:
            logger.error(f"JWT signature verification failed: {e}")
            return None
