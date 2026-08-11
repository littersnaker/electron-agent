"""Software Factory 前端技术栈检测与模板生成。"""

from backend.software_factory.frontend.detector import (
    FrontendProjectProfile,
    detect_frontend_profile,
)
from backend.software_factory.frontend.templates import (
    render_api_client,
    render_contracts,
    render_data_source,
    render_integration_guide,
    render_mock_data,
    render_mock_repository,
)

__all__ = [
    "FrontendProjectProfile",
    "detect_frontend_profile",
    "render_api_client",
    "render_contracts",
    "render_data_source",
    "render_integration_guide",
    "render_mock_data",
    "render_mock_repository",
]
