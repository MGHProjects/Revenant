# Guía para construir Revenant con Kiro

Esta guía es para ti, no para el jurado. Los prompts van en inglés porque el repo y la entrega
son en inglés. Fecha límite: **viernes 4 de diciembre de 2026, 23:00 hora peninsular**.

## Regla de oro

El 20% de la nota es "cómo de bien usaste Kiro" y el write-up tiene que ser verdad. Por eso:

- La spec, el diseño y las tareas definitivas las genera **Kiro**. Lo que hay en `docs/brief/`
  es material de entrada escrito a mano, y así debes contarlo.
- Después de cada sesión apunta dos líneas en `docs/build-log.md` (plantilla al final). De ahí
  sale el write-up. Sin esas notas acabarás inventando, y se nota.

## Calendario

| Días | Qué |
|---|---|
| 17 nov | Fase 0 y 1. Pedir créditos (tardan hasta 48 h laborables; límite 1 dic) |
| 18–19 nov | Fase 2: spec completa |
| 20–24 nov | Fase 3 y 4: núcleo, red, API |
| 25–28 nov | Fase 5: interfaz |
| 29–30 nov | Fase 6 y 7: CLI, MCP, despliegue |
| 1–2 dic | Vídeo, blog, post en redes |
| 3 dic | Enviar. El 4 es margen, no día de trabajo |

## Fase 0 — Preparar

1. Regístrate en https://kiroween.devpost.com y pide créditos en la pestaña Resources.
2. Instala Kiro IDE y abre esta carpeta. Acepta confiar en el workspace (si no, no carga `.kiro/agents`).
3. Crea el repo público en GitHub con licencia MIT visible y sube este estado como primer commit.
4. En el panel de Kiro comprueba que aparecen 4 steering, 3 hooks y el agente `gravekeeper`.
   Si algún hook no carga, pídele a Kiro que lo arregle; el formato lo leí de la doc el 16 nov.

## Fase 1 — Que Kiro critique el planteamiento

Chat normal:

```text
Read .kiro/steering/ and docs/brief/. Do not write code. Tell me: (1) what is ambiguous or
contradictory, (2) which requirement is hardest to implement on Cloudflare Workers and why,
(3) what you would cut to ship in 10 days. Be specific and brief.
```

Corrige el brief con lo que tenga sentido. Apunta en el build log qué encontró.

## Fase 2 — Spec (Requirements-First)

Panel Kiro → Specs → `+` → Feature → Requirements-First. Nombre: `revenant`.

```text
Build the spec for Revenant from #docs/brief/requirements.md. Keep its numbering and EARS
wording. Do not add requirements; if something is missing, ask me first.
```

1. Lanza **Analyze Requirements** y resuelve lo que detecte. Esto solo existe en IDE y CLI.
2. Fase de diseño:

```text
Write the design using #docs/brief/design-brief.md and #docs/brief/calibration.md as input.
Keep the pure-core boundary and the Fetcher injection. Every one of the 7 properties in the
brief must appear as a correctness property linked to its requirement; add others you find.
```

3. Revisa que las propiedades salen enlazadas a requisitos (al pasar el ratón). La extracción
   de propiedades solo funciona en el **IDE**, no en CLI ni Web.
4. Genera las tareas. Compáralas con `docs/brief/task-outline.md` y pide cambios si falta algo.
   Marca las tareas de tests de propiedades como obligatorias, no opcionales.

## Fase 3 — Hooks

Los tres de `.kiro/hooks/quality.json` ya están. Añade el cuarto pidiéndoselo a Kiro (no lo
escribí yo porque no pude confirmar el nombre exacto del trigger):

```text
Create a hook that runs `npm test` after every spec task finishes and feeds failures back to
you. Put it in .kiro/hooks/.
```

## Fase 4 — Núcleo, red y API

- Ejecuta las tareas del núcleo **una a una** (no "run all"). Después de cada una, cambia al
  agente `gravekeeper` y pídele: `Inspect task 3.1`. Si rechaza, vuelve al agente normal y arregla.
- Ejecuta los tests de propiedades desde la spec. Cuando uno falle, **guarda el contraejemplo**
  en el build log: es la mejor prueba para el write-up.
- Para red y API sí puedes usar ejecución en paralelo; apunta si funcionó bien.

## Fase 5 — Interfaz

Aquí compara los dos modos, porque el jurado lo pregunta:

1. La estructura (tareas 8.1, 8.2, 8.4, 8.5) con la spec.
2. La escena SVG (8.3) en modo vibe, iterando con capturas de pantalla.
3. Apunta qué modo fue mejor para qué.

Prueba el resultado con `samples/haunted-readme.md`: tiene que salir cada veredicto esperado.

## Fase 6 — CLI, MCP y usar el propio producto

1. Tareas de CLI y MCP.
2. Registra el servidor en `.kiro/settings/mcp.json`:

```json
{ "mcpServers": { "revenant": { "command": "node", "args": ["dist/mcp/server.js"], "autoApprove": ["check_links"] } } }
```

3. Pide a Kiro que use `check_links` sobre el README del repo y sobre `docs/`. Captura de
   pantalla: es la demostración de MCP para el vídeo.
4. Usa **Kiro CLI** al menos para una cosa real (por ejemplo, la tarea del CLI) y apunta la
   diferencia con el IDE.

## Fase 7 — Desplegar y verificar

1. `npm run deploy` (Cloudflare).
2. Abre la URL pública, pulsa el botón de muestra y comprueba los cuatro veredictos **desde el
   despliegue**. Los 403 y las redirecciones pueden cambiar según la red; si alguno cambia,
   sustituye el enlace en la muestra y en `calibration.md`.
3. Prueba con teclado solo, y con "reducir movimiento" activado en el sistema.

## Extras opcionales, por orden de rentabilidad

1. **Blog** (100 premios): cuenta el hallazgo de `calibration.md`. Debe mencionar Kiroween 2026.
2. **Post en redes** empezando por `#KiroweenHackathon26`. Escríbelo tú: puntúan que no suene a IA.
3. **Mejor proyecto de startup** (10.000 $): si entras como fundador de MGH Projects, con LinkedIn y web.
4. **Ghost of Kiroween Past**: solo si te registraste en Kiroween 2025.
5. **App de Kiro Crew** (1.000 $): repo aparte. Una app que revise un repo cada semana con el
   mismo motor. Solo si te sobran dos días.

## Plantilla de `docs/build-log.md`

```markdown
## 2026-11-18 — spec
- Kiro feature used:
- What it did well:
- What I had to correct:
- Evidence (file, screenshot, counterexample):
```
