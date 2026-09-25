# Solfy

**Karaoke y solfeo con piano guía, 100 % en tu PC.**

Subes un MP3 y Solfy separa la voz de la música, convierte la melodía del cantante en notas de piano y te deja cantar o solfear encima. Las notas que tienes que cantar aparecen como barras rojas que se acercan a una línea central. Tu voz se dibuja en verde encima de ellas. Al final de cada canción recibes un puntaje, y se guarda un historial con tus promedios.

> Prototipo v0.1 para Windows. Funciona sin internet y no envía tus datos a ningún lado (ver [PRIVACY.md](PRIVACY.md)).

## Qué hace

- **Solo MP3** (hasta 60 MB / 15 min). El procesamiento es local y tarda unos minutos por canción en una CPU normal. Se hace una sola vez.
- **Separación de voz** con Demucs (`htdemucs`) y **melodía** con CREPE.
- **Dos dificultades:**
  - **Normal:** la melodía como la canta el artista.
  - **Aprendizaje:** una versión "redondeada". Las notas rápidas y los adornos se absorben en notas largas, los huecos pequeños se rellenan y todo se ajusta a la grilla de corcheas. Sirve para aprender la línea antes de pasar al modo Normal.
- **Escuchar guía** (el piano toca la melodía) y **Tu turno** (micrófono, rastro verde y puntaje).
- **Qué suena:** piano + instrumental, solo piano, solo instrumental, o instrumental con el piano bajito.
- **Velocidad** del 50 al 100 % sin cambiar el tono, **transposición** de ±12 semitonos, **octava libre** (cantar una octava arriba o abajo cuenta como correcto) y **bucle A-B** para repetir una frase.
- **Editor básico:** borrar notas, subirlas o bajarlas un semitono, unirlas y escribir la letra por nota. Los cambios se guardan también en el MIDI, y siempre puedes restaurar la versión original.
- **MIDI** de cada canción (Normal y Aprendizaje), exportable con un clic.
- **Letra opcional:** se activa con la casilla "Transcribir letra" al subir la canción (usa Whisper, local). Es aproximada: en canto, y más en salsa, se equivoca bastante. Por eso se puede corregir en el editor.
- **Nombres de notas** en Do-Re-Mi o en C-D-E. **Tema claro y oscuro.**
- **Historial:** todos tus intentos, promedio, mejor puntaje, promedio de los últimos 5 y promedio de las canciones completas.

## Instalar

1. Ve a [Releases](https://github.com/juansepasca17/Solfy/releases) y descarga `Solfy-Setup-x.y.z.exe`. Si quieres verificarlo, compara su huella con `SHA256SUMS.txt`.
2. El instalador **no está firmado**, así que Windows SmartScreen va a mostrar "Windows protegió su PC". Haz clic en *Más información → Ejecutar de todas formas*. Firmar el instalador requiere un certificado de pago.
3. Usa **audífonos** para cantar. Si no, el micrófono capta el piano y la música de los parlantes.

El instalador es grande (cientos de MB) porque trae adentro los modelos de IA. Así la app nunca tiene que conectarse a internet.

## Cómo funciona

```
MP3 ─► Demucs ─► voz ─► CREPE (tono cada 10 ms) ─► limpieza ─► notes.json / notes_learning.json
            └──► instrumental.ogg                                            └─► melody.mid
```

`notes.json` usa este esquema:

```json
[{"note": "C4", "freq": 261.63, "start": 1.20, "end": 1.85}]
```

### Problemas de la voz real y cómo se resuelven

| Problema | Solución |
|---|---|
| Vibrato | Mediana suavizada, cuantización con histéresis y la **mediana** del segmento como nota final |
| Portamento / glissando | La pendiente se mide sobre ~0.2 s: el vibrato se cancela, el deslizamiento no. Los restos de menos de 80 ms se descartan |
| Errores de octava del detector | Los tramos cortos que saltan ±12 respecto del contexto se devuelven a la octava correcta |
| Grabaciones que no están en A440 (común en discos viejos) | Se calcula la desafinación global y se corrige. El piano se reproduce con esa misma desafinación para sonar afinado con la banda |
| Coros, metales o ruido que se cuelan en la voz separada | Umbrales de periodicidad y de energía. Lo que se escape se arregla en el editor |
| Notas diminutas y soneos rápidos | Modo Aprendizaje (notas de 0.25 s como mínimo, absorción de melismas, grilla de corcheas) |
| Tu rango de voz es distinto al del cantante | Transposición y "octava libre" |
| Latencia del micrófono | Ajuste manual o calibración con 8 clics (Ajustes) |

### Puntaje

Por cada lectura del micrófono dentro de una nota: ±50 cents vale 1 punto, ±100 cents vale 0.5 y fuera de eso vale 0. El puntaje (0–100) es el promedio de las notas ponderado por su duración. Una nota cuenta como **acertada** si más del 60 % de sus lecturas caen dentro de ±50 cents. Calificaciones: S ≥ 90, A ≥ 75, B ≥ 60, C ≥ 40.

## Desarrollo

Requisitos: Python 3.11 (con [uv](https://docs.astral.sh/uv/) o similar) y Node 22 o superior.

```bash
cd engine
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements-dev.txt --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
.venv/Scripts/python -m pytest -q tests
cd ..
engine/.venv/Scripts/python scripts/fetch_models.py      # descarga los modelos a models/
cd app && npm install && npm start
```

En desarrollo, la app usa `engine/.venv` directamente. Para probar el motor solo:

```bash
engine/.venv/Scripts/python scripts/make_test_song.py prueba.mp3
cd engine && .venv/Scripts/python -m solfy_engine process --input ../prueba.mp3 --out ../salida --models ../models
```

### Build del instalador

```bash
cd engine && .venv/Scripts/pyinstaller solfy_engine.spec --noconfirm
cd ../app && npx electron-builder --win nsis --publish never
```

### Releases

Sube un tag `vX.Y.Z` que coincida con la versión de `app/package.json`. El workflow [release.yml](.github/workflows/release.yml) construye el instalador en GitHub Actions y lo publica en Releases junto con su SHA256.

## Estructura

```
engine/   motor Python (separación, tono, notas) → solfy-engine.exe
app/      Electron + HTML/Canvas/JS nativo (sin frameworks)
scripts/  descarga de modelos, canción de prueba, ícono
```

## Aviso

Solfy es para uso personal y de estudio. Las canciones que subes y todo lo que se genera a partir de ellas (pistas, notas, MIDI) se quedan en tu PC. Respeta los derechos de autor: no redistribuyas ese material.

## Créditos

Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) de Alexander Holm (CC-BY 3.0). Separación: [Demucs](https://github.com/facebookresearch/demucs) (MIT). Tono: [torchcrepe](https://github.com/maxrmorrison/torchcrepe) (MIT). Letra: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT). Licencia del proyecto: [MIT](LICENSE).
