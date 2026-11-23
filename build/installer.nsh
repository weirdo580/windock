!macro customInstall
  ; 使用当前用户的开始菜单路径，避免在静默安装时依赖 $SMPROGRAMS 的上下文。
  CreateShortcut "$APPDATA\Microsoft\Windows\Start Menu\Programs\WinDock 设置.lnk" "$INSTDIR\WinDock.exe" "--settings"
!macroend

!macro customUnInstall
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\WinDock 设置.lnk"
!macroend
