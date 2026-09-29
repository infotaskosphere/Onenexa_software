"""Guards against NameError 500s in the license-issuing path."""


def test_licensee_admin_module_imports_os():
    import backend.commercial_licensee_admin as m
    assert hasattr(m, "os")  # os.getenv("DEFAULT_TENANT_ADMIN_PASSWORD") is used


def test_licensing_api_defines_logger_for_email_failure_handler():
    import backend.licensing_api as m
    assert hasattr(m, "logger")
    m.logger.warning("logger is usable")
