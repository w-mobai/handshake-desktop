!macro customInstall
  SetRegView 64

  ${ifNot} ${isUpdated}
    ClearErrors
    ReadRegDWORD $0 HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileSizeLimitInBytes"
    ${if} ${errors}
      WriteRegDWORD HKLM "Software\Handshake\InstallerBackup" "HadFileSizeLimit" 0
    ${else}
      WriteRegDWORD HKLM "Software\Handshake\InstallerBackup" "HadFileSizeLimit" 1
      WriteRegDWORD HKLM "Software\Handshake\InstallerBackup" "FileSizeLimitInBytes" $0
    ${endIf}
  ${endIf}

  ; Windows WebDAV 使用 DWORD 保存文件大小限制，设为最大值（约 4 GB）。
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileSizeLimitInBytes" 0xffffffff

  ; 仅将三个标准私有局域网段加入“本地 Intranet”（区域编号 1）。
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake10" ":Range" "10.*"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake10" "*" 1
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake172" ":Range" "172.16-31.*"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake172" "*" 1
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake192" ":Range" "192.168.*"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake192" "*" 1

  ; Windows 会把带点的 IP/主机名当作 Internet；信任局域网 mDNS 的 .local 域。
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\local" "*" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\local" "*" 1

  ; 让新限制立即生效，并确保 WebDAV 客户端服务可用。
  nsExec::ExecToLog 'sc.exe config WebClient start= demand'
  nsExec::ExecToLog 'net.exe stop WebClient /y'
  nsExec::ExecToLog 'net.exe start WebClient'
!macroend

!macro customUnInstall
  SetRegView 64

  ReadRegDWORD $0 HKLM "Software\Handshake\InstallerBackup" "HadFileSizeLimit"
  ${if} $0 == 1
    ReadRegDWORD $1 HKLM "Software\Handshake\InstallerBackup" "FileSizeLimitInBytes"
    WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileSizeLimitInBytes" $1
  ${else}
    DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileSizeLimitInBytes"
  ${endIf}

  DeleteRegKey HKLM "Software\Handshake\InstallerBackup"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake10"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake172"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Handshake192"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\local"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\local"
!macroend
