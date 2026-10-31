# Instalar e usar a Antares

A Antares é uma interface de editor, aberta e **não oficial**, para o **Muse Code**. Roda dentro do VS Code ou de um editor baseado nele, como o Antigravity IDE, e conversa com o seu `muse` instalado. Versão em inglês: [INSTALL.md](INSTALL.md).

## 1. O que você precisa antes

| Precisa | Como conferir |
|---|---|
| **Muse Code instalado e com login feito** | No terminal, `muse --version` mostra a versão (testado com a **1.4.14**) e você já rodou `muse login` uma vez. A Antares nunca mexe no seu login. |
| **VS Code 1.90+ ou editor compatível** | Testado no VS Code 1.143.1 e no Antigravity IDE 1.107.0 (Windows). |
| **Uma pasta de projeto** | Abra a pasta do projeto no editor antes. O Muse trabalha dentro de uma pasta. |
| *(opcional)* Python 3.9+ | Só para ditado de voz local com faster-whisper. |

O Windows é a plataforma testada. No macOS e no Linux o chat pode funcionar, mas não foi testado, e a gravação de voz é só para Windows por enquanto.

## 2. Instalar

1. Baixe o **`antares-0.1.0.vsix`** na [página de Releases](https://github.com/Ald3b4r4n/antares/releases) (é uma pré-release).
2. Instale de um destes jeitos:
   - **No editor:** abra a vista de Extensões, clique no menu **`...`** no topo, escolha **Instalar do VSIX...** e selecione o arquivo.
   - **Pelo terminal:** `code --install-extension antares-0.1.0.vsix` (troque `code` pelo comando do seu editor, por exemplo `antigravity-ide`, que fica na pasta `bin` da instalação do editor).
3. **Recarregue a janela:** `Ctrl+Shift+P` e *Developer: Reload Window*.

Para compilar você mesmo: `git clone https://github.com/Ald3b4r4n/antares`, depois, em `muse-extension`, rode `npm install`, `npm run build`, `npm run package` e instale o `.vsix` gerado (Node.js 22+).

## 3. Abrir

- Clique no **ícone da Antares na barra de atividades** (a faixa da esquerda), ou
- `Ctrl+Shift+P` e **Antares: Open**.

O chat abre ao lado do editor, com o banner da Antares. Se aparecer "Muse executable not found", configure `antares.musePath` (próxima seção).

## 4. Configurar (tudo opcional)

Abra as Configurações (`Ctrl+,`) e procure por **antares**, ou edite o `settings.json`:

```json
{
  "antares.musePath": "C:\\Users\\voce\\AppData\\Local\\Programs\\muse\\muse.exe",
  "antares.initialProfile": ":read-only",
  "antares.usage.alertThresholds": [80, 95],
  "antares.voice.home": "D:\\programas\\Antares\\voice"
}
```

| Configuração | O que faz |
|---|---|
| `antares.musePath` | Caminho completo do `muse` quando ele não está no `PATH`. |
| `antares.initialProfile` | Perfil de permissão em que um chat novo começa. Padrão `:read-only` (o modo **Plan**). |
| `antares.usage.alertThresholds` | Percentuais das janelas da assinatura que disparam alerta (padrão 80 e 95). |
| `antares.usage.refreshOnOpen` | Ler o uso atualizado ao abrir um chat (sem chamar modelo, no máximo uma vez por minuto). |
| `antares.voice.*` | Ditado de voz (abaixo). |

## 5. Opcional: ditado de voz

O ditado transforma sua voz em texto **no seu computador**; o texto cai na caixa de mensagem para você revisar. O áudio nunca é enviado a lugar nenhum e a gravação temporária é apagada.

1. `Ctrl+Shift+P` e **Antares: Set up local voice**.
2. Leia o diálogo: ele lista o que será baixado (um ambiente Python privado, o `faster-whisper` e um modelo Whisper, cerca de **450 MB** com o modelo `base`) e onde. Dá para escolher outra pasta, por exemplo um disco com mais espaço. Nada acontece até você aceitar.
3. Ao terminar, clique no botão do **microfone** no chat. Clique de novo para parar; `Esc` cancela.

Se você instalou a voz em outra pasta, confira se `antares.voice.home` aponta para ela. A fala do Windows é uma alternativa sem download, mas precisa de um reconhecedor de voz de desktop instalado para o seu idioma. Detalhes: [VOICE.md](VOICE.md).

## 6. Usar

**O rodapé** mostra o modelo, o esforço, o uso de contexto e, quando o Muse informa, as janelas de 5 horas e semanal da sua assinatura.

**Modos de permissão** (seletor ao lado do modelo; `Shift+Tab` na caixa de mensagem alterna; as teclas `1` a `5` escolhem no menu aberto):

| Modo | O que o Muse pode fazer |
|---|---|
| **Plan** (padrão) | Só leitura. Peça um plano (tente `/plan`). |
| **Accept edits** | Edita o workspace sem perguntar; pergunta para escritas protegidas, rede nova e outras ações restritas. |
| **Auto** | Mesmo acesso, com um revisor automático decidindo primeiro. |
| **Bypass permissions** | Sem sandbox e sem pedidos de aprovação. Só para projetos que você aceite expor. |
| Manual | Indisponível: o Muse não tem um perfil que pergunte antes de toda edição. |

Trocar de modo mantém a conversa. Qualquer coisa acima de Plan pede confirmação antes.

**O botão "+"** adiciona arquivos e fotos (`Ctrl+U`), uma pasta, o arquivo atual, a seleção, uma skill (`/`), mostra conectores e plugins, instala plugins e importa skills. Também dá para colar ou soltar imagens e arquivos. Arquivos fora do workspace precisam de *Add folder* antes.

**Enquanto o Muse trabalha:** `Enter` orienta o turno em andamento; `Ctrl+Enter` enfileira a mensagem.

**O que o Muse mudou:** edições de arquivo mostram um diff no cartão da ferramenta, e o botão **Changes** lista todos os arquivos alterados com um diff por arquivo.

**Aprovações:** cada uma mostra exatamente o que está sendo pedido, com as escolhas do próprio Muse. A Antares nunca decide por você.

## 7. Se algo não funcionar

| Sintoma | O que fazer |
|---|---|
| "Muse executable not found" | Configure `antares.musePath`. |
| "sandbox unavailable", comandos de shell falham | Leia o [SANDBOX.md](SANDBOX.md). É um problema conhecido do `muse serve` no Windows; Plan e Accept edits ainda leem e editam, e o Bypass roda comandos (sem sandbox). |
| O microfone diz que a voz precisa de configuração | Rode **Antares: Set up local voice** ou configure `antares.voice.home`. |
| O ditado sai no idioma errado | Configure `antares.voice.language` (por exemplo `pt`); veja o [VOICE.md](VOICE.md#the-text-comes-out-in-the-wrong-language). |
| Sem login | Rode `muse login` em um terminal e abra um chat novo. |
| Controle de navegador | Precisa de um servidor MCP que você configura no Muse: [BROWSER.md](BROWSER.md). |

## 8. Atualizar e desinstalar

- **Atualizar:** instale o `.vsix` mais novo por cima do antigo e recarregue a janela.
- **Desinstalar:** vista de Extensões, Antares, *Uninstall*. Para remover a voz, apague a pasta que você escolheu (padrão `%LOCALAPPDATA%\Antares\voice`).

## 9. Privacidade em um parágrafo

A Antares inicia o `muse serve` oficial e conversa com ele localmente. Não lê o seu `auth.json`, não chama o endpoint que gera chaves e não chama a API do modelo por conta própria. Os números de uso vêm do Muse. O áudio da voz fica na sua máquina. A Antares não envia nada a servidor próprio (ela não tem nenhum).

## 10. O que ainda falta na 0.1.0

- **Entrada de vídeo** (não construída; não deu para testar de ponta a ponta).
- **Worktrees** (a própria checagem de git do host expirou na máquina de teste).
- **Gravação de voz no macOS e no Linux** (só Windows).
- **Terminal embutido** (deixado de fora de propósito).
- **Adicionar ou remover servidores MCP** e **ler o estado ligado/desligado de uma skill** (o protocolo não oferece).
- **A imagem que o modelo viu por uma ferramenta** e **imagens geradas pelo modelo** (o Muse não as expõe).
- **Não verificado com serviços reais:** OAuth de conectores contra um provedor real, plugins que trazem hooks ou servidores MCP, o revisor do modo Auto e um servidor de navegador real.
- **Ainda não publicada** no Open VSX nem no Marketplace do VS Code; instale pelo `.vsix`.

O estado completo por fase está no [roadmap do README](../README.md#roadmap) e no [PLAN.md](PLAN.md).
