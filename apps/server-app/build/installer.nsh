; Pare-feu Windows : les PC du magasin (ou via Tailscale) doivent pouvoir joindre le serveur.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FEDO Serveur" dir=in action=allow program="$INSTDIR\FEDO Serveur.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
!macroend
