"""Software Factory 蓝图、Mock、生成文件与页面接入校验。"""

from backend.software_factory.validation.integration import (
    validate_workspace_integration,
)
from backend.software_factory.validation.validator import validate_factory_artifacts

__all__ = ["validate_factory_artifacts", "validate_workspace_integration"]
