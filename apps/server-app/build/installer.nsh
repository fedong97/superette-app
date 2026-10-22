; Pare-feu Windows : les PC du magasin (ou via Tailscale) doivent pouvoir joindre le serveur.
; Les regles "FEDO Serveur" et "FEDONIX 360 Serveur" viennent des anciens noms du logiciel :
; elles visent un executable qui n existe plus, on les retire aussi.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDONIX 360 Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ONIX 360 Serveur"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ONIX 360 Serveur" dir=in action=allow program="$INSTDIR\ONIX 360 Serveur.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDO Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FEDONIX 360 Serveur"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ONIX 360 Serveur"'
!macroend
