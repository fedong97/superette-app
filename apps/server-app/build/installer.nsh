; Pare-feu Windows : les PC du magasin (ou via Tailscale) doivent pouvoir joindre le serveur.
; La regle "FEDO Serveur" vient des versions d avant le nom FEDONIX 360 : on la retire aussi.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDONIX 360 Serveur"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FEDONIX 360 Serveur" dir=in action=allow program="$INSTDIR\FEDONIX 360 Serveur.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDONIX 360 Serveur"'
!macroend
