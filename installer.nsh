!macro customUnInstallSection
  Section /o "un.删除用户数据（配置、任务记录和日志）" SEC_DELETE_USER_DATA
    # Electron stores userData under %APPDATA%\<app name>. Match electron-builder's built-in deletion paths.
    !ifdef INSTALL_MODE_PER_ALL_USERS
      SetShellVarContext current
    !else
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
    !endif

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    !ifdef INSTALL_MODE_PER_ALL_USERS
      SetShellVarContext all
    !else
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    !endif
  SectionEnd
!macroend