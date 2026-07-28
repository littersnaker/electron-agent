; Multi-agent installer customization
; Only the documented electron-builder welcome-page hooks are used.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "一处工作空间，协同 Code、QA、Media 与 Commerce Agent。$\r$\n$\r$\n点击“下一步”开始安装。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "卸载 ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "这将从当前设备移除 ${PRODUCT_NAME}。$\r$\n$\r$\n点击“下一步”继续。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
