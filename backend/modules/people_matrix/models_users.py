            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    @field_validator("birthday", mode="before")
    @classmethod
    def empty_string_to_none(cls, v):
        if v == "" or v is None:
            return None
        return v


class UserCreate(BaseModel):
    full_name: str
    email: str
    password: str
    role: UserRole = UserRole.staff
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    telegram_id: Optional[int] = None
    punch_in_time: Optional[str] = "10:30"
    grace_time: Optional[str] = "00:10"
    punch_out_time: Optional[str] = "19:00"
    profile_picture: Optional[str] = None
    is_active: bool = True
    permissions: Optional[Dict[str, Any]] = None
    status: Optional[str] = "pending_approval"
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    recovery_email: Optional[str] = None
    notification_email: Optional[str] = None
    email_verified: bool = False
    email_notifications_enabled: bool = True
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, v):
        if not isinstance(v, str) or len(v) < 12:
            raise ValueError("Password must be at least 12 characters.")
        return v


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    departments: Optional[List[str]] = None
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    punch_in_time: Optional[str] = None
    grace_time: Optional[str] = None
    punch_out_time: Optional[str] = None
    is_active: Optional[bool] = None
    profile_picture: Optional[str] = None
    telegram_id: Optional[int] = None
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    recovery_email: Optional[str] = None
    notification_email: Optional[str] = None
    email_verified: Optional[bool] = None
    email_status: Optional[str] = None
    email_notifications_enabled: Optional[bool] = None
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None

    @field_validator("password")
    @classmethod
    def validate_optional_password_length(cls, v):
        if v is not None and len(v) < 12:
            raise ValueError("Password must be at least 12 characters.")
        return v

    model_config = ConfigDict(from_attributes=True, extra="ignore")


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str
    user: User
    consent_given: Optional[bool] = None  # Fixed: was 'Noner'
    session_token: Optional[str] = None  # for POST /auth/logout