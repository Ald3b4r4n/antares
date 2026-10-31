# Extensão VS Code / Antigravity para o Muse Code — plano

Estado: **planejamento**, 31/10/2026. Base: contrato MSP exportado por `muse.exe` 1.4.14-R7309.1 (`rea-musecode/2026-10-31/schema*`, `protocol-methods.md`). Nada aqui foi testado em runtime além do handshake e sessão `echo` já documentados.

## Decisões tomadas com o usuário

| Tema | Decisão |
|---|---|
| Áudio | Transcrição **local com Whisper**; o texto transcrito vai como parte `text`. O Muse não aceita áudio (partes de entrada: `text`, `image`, `skill`, `video`) |
| Interface | **Webview próprio**, igual no VS Code e no Antigravity |
| Gasto | % das janelas 5h e semanal (`usage/read`), tokens por sessão e por dia (soma local), alerta ao chegar em X%. **Sem estimativa em reais** (o protocolo não expõe valores monetários) |
| MVP | Chat com streaming + copiar/colar; aprovações com perfil/sandbox visíveis; seletor de modelo + uso/tokens; sessões (lista, retomar, ramificar) |

## Princípios e limites

- A extensão é **cliente do `muse serve`** (stdio, JSON-RPC 2.0 por linhas, `commandId` UUIDv7). O binário oficial continua sendo dono de login, inferência e sandbox.
- **Não** ler `auth.json`, **não** chamar mint/inferência diretamente, **não** reutilizar a assinatura como crédito de API genérico. Login pelo host (`account/loginStart`, device code), que é experimental.
- Perfil padrão pedido no `session/start`: `:ask-me` ou `:auto-review`, nunca `:unrestricted` sem ação explícita. Perfil e disponibilidade do sandbox sempre visíveis (já vimos `unavailable` em contexto isolado).
- Conferir o fingerprint do schema no `initialize`; avisar se divergir da versão suportada.
- Termos de uso da assinatura não foram lidos: o usuário deve conferir antes de distribuir.

## Matriz de funções

| Função | Método / origem | Fase |
|---|---|---|
| Streaming de turno | `turn/start`, `view/subscribe`, `view/page`, `view/gap` | MVP |
| Parar / direcionar / enfileirar | `turn/interrupt` (retract), `turn/steer`, `turn/unqueue` | MVP |
| Botão ⧉ copiar (mensagem, bloco de código, saída de shell, diff) | cliente; `item/readOutput` para saídas longas | MVP |
| Colar texto e imagem; arrastar imagem | partes `text` e `image` (base64 + mediaType) | MVP |
| Menção de arquivo | `@caminho/relativo` em parte `text` | MVP |
| Aprovações e perguntas do agente | `approval/request`, `approval/decide`, user input | MVP |
| Perfil, sandbox, 5 eixos de limite | `permissionProfile/list`, `session/setPermissionProfile`, `session/readLimits` (experimentais) | MVP |
| Modelo e esforço de raciocínio | `model/list`, `session/setModel`, `session/setReasoningEffort` | MVP |
| Tokens e contexto | `session/tokenUsage`, `session/contextUsage` | MVP |
| Uso da assinatura | `usage/read`; `usage/refresh` só sob demanda (1 por 60 s, faz mint) | MVP |
| Sessões | `session/list`, `read`, `resume`, `fork`, `rename`, `compact` | MVP |
| Voz (Whisper local) | cliente: captura, transcreve, insere texto no campo | Fase 2 |
| Skills (`/`) | `skill/list`, parte `skill`, `skill/import` | Fase 2 |
| Worktrees | `session/start.worktree`, `worktree/list`, `session/branchChanged` | Fase 2 |
| MCP, plugins, hooks | `mcpServer/*`, `plugin/*`, `hook/list` | Fase 3 |
| Diff no editor, terminal | cliente | Fase 3 |
| Vídeo | `media/upload` + parte `video` | Fase 4 |
| Rewind / checkpoint | sem método dedicado visto; `session/fork` com cut point | A investigar |

## Fases

0. **Spike**: portar `probe-msp-echo.py` para TypeScript; `initialize` + `session/start` com provider `echo` no extension host, em VS Code e Antigravity. Gerar tipos a partir dos schemas.
1. **MVP** (tabela acima).
2. Voz, skills, worktrees.
3. MCP/plugins/hooks, diff e terminal.
4. Vídeo, polimento, empacotamento VSIX (Open VSX para o Antigravity).

## Pendências e riscos

- Formato real dos eventos de item/streaming só foi visto com `echo`. Validar com um turno real exige login e chamada paga: **só com aval do usuário**.
- Se `model/list` cobre todos os modelos da conta: desconhecido até uma chamada real.
- `muse serve` em stdio como processo filho do extension host no Windows: não testado.
- APIs do Antigravity (webview, terminal) assumidas iguais às do VS Code: não verificado.
- Superfície experimental pode mudar entre versões do Muse.
- Contagem local de tokens cobre só o uso feito pela extensão.
- Whisper: escolher tamanho do modelo (precisão vs. memória; a máquina tem pouca RAM livre).
