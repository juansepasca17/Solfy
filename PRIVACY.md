# Privacidad

Solfy no recopila, envía ni comparte ningún dato.

- **Sin internet.** La app bloquea en su código todas las conexiones de red (`http`, `https`, `ws`, `wss`, `ftp`). Los modelos de IA vienen dentro del instalador y el motor corre en modo offline (`HF_HUB_OFFLINE=1`).
- **Sin telemetría, sin reportes de fallos, sin actualizaciones automáticas.** Las versiones nuevas se descargan a mano desde GitHub Releases.
- **Tus archivos se quedan en tu PC**, en `%APPDATA%\Solfy\`:
  - `library\<id>\`: copia del MP3, pistas separadas, notas, MIDI y letra.
  - `scores.json`: tu historial de puntajes.
  - Las preferencias (tema, notación, latencia) se guardan en el almacenamiento local de la app.
- **Micrófono:** solo se usa en el modo "Tu turno", solo para la propia app y solo audio. El sonido se analiza en tiempo real en memoria y **no se graba ni se guarda**. La app rechaza cualquier otro permiso (cámara, ubicación, notificaciones…).
- **Borrar datos:** el botón "Borrar" de cada canción elimina su carpeta y sus puntajes. Para borrar todo, desinstala Solfy y elimina `%APPDATA%\Solfy\`.

## Cómo comprobarlo

Con Solfy abierto y procesando o reproduciendo una canción, en PowerShell:

```powershell
Get-Process Solfy, solfy-engine -ErrorAction SilentlyContinue |
  ForEach-Object { Get-NetTCPConnection -OwningProcess $_.Id -ErrorAction SilentlyContinue }
```

No debería aparecer ninguna conexión. También puedes desconectar el Wi-Fi: todo sigue funcionando igual.
