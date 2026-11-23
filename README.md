# @the-seeker/madefeed

[MadeFeed](https://madefeed.dev) 토큰 미터예요. 이 컴퓨터에서 AI 코딩 도구로 쓴 토큰 합계를 읽어 MadeFeed 계정에 올려요. 올린 토큰만큼 제품에 투표할 표가 생겨요.

## 쓰는 법

```sh
npx @the-seeker/madefeed@latest
```

처음 실행하면 브라우저에서 기기를 연결하고, 이어서 사용량을 올려요. Node.js 22.15 이상이 필요해요.

한 컴퓨터는 한 번에 한 계정에만 연결할 수 있어요. 계정을 바꾸려면 이전 계정에서 먼저 `npx @the-seeker/madefeed@latest logout`으로 연결을 끊은 뒤 새 계정에 연결해 주세요. 새 연결에는 0.5.0 이상이 필요해요.

첫 연결에서는 `--days`와 관계없이 오늘 포함 지난 30일(KST)의 사용량을 올려요. 연결 전 기록 합산은 **계정당 한 번**이에요. 다시 연결해도 이미 합산한 과거 기록은 중복으로 더하지 않아요. 같은 서버에 다시 로그인하면 새 토큰을 받은 뒤 이전 기기 연결부터 해제해요. 이전 버전에서 연결한 기기도 다음 실제 전송(예약 전송 포함)에서 30일 합산을 한 번 시도해요. 서버가 합산을 마감했어도 이후에는 평소 기간으로 전송해요. `--dry-run`은 네트워크 요청 없이 지정한 `--days` 기간만 보여주며, 첫 합산 상태를 바꾸지 않아요.

전송 결과에는 제외한 기록 수(있을 때), 지난 사용량 합산 여부, 남은 **누적 표**가 표시돼요. 누적 표는 쓰기 전까지 남아 있는 투표 잔액이에요. 예전 서버가 잔액을 보내지 않으면 표시하지 않아요.

0.6.0부터 Codex가 7일이 지난 세션을 압축한 기록도 읽어요. 이전 버전에서는 약 일주일보다 오래된 Codex 사용량이 빠졌어요. 기존 기기는 다음 전송에서 지난 30일을 한 번 다시 합산하며 기존 값보다 줄이지 않아요. 자동 전송은 새 버전을 자동으로 받지 않으므로 `npx @the-seeker/madefeed@latest`를 한 번 실행해 복사본을 갱신하고 재합산해 주세요. Node.js가 22.15 미만이면 재합산을 미루므로 Node.js를 올린 뒤 다시 실행해요. 최초 합산 뒤 연결을 끊고 다시 연결했다면 이전 기록은 그대로 남아요.

`login --json`은 연결과 전송을 마친 뒤 표준 출력에 JSON 객체 하나만 출력해요. 예: `{"loggedIn":true,"accepted":12,"ignored":0,"backfill":"applied","weekTokens":3000000,"votesGranted":3,"bankVotes":3}`. 연결 안내는 표준 오류로 나가요. `upload --json`은 `loggedIn` 없이 같은 전송 결과를 출력해요. 예전 서버에서는 `ignored`는 `0`, `backfill`은 `null`이고 `bankVotes`는 생략돼요.

| 명령 | 하는 일 |
| --- | --- |
| `npx @the-seeker/madefeed@latest` 또는 `npx @the-seeker/madefeed@latest upload` | 연결이 없으면 연결하고, 사용량을 올려요. |
| `npx @the-seeker/madefeed@latest login` | 기기를 연결하고 지난 30일 사용량을 올려요. |
| `npx @the-seeker/madefeed@latest status` | 연결과 자동 전송 상태를 보여줘요. |
| `npx @the-seeker/madefeed@latest auto [status]` | 자동 전송 상태를 보여줘요. `--json`도 지원해요. |
| `npx @the-seeker/madefeed@latest auto on` | 연결된 기기의 자동 전송을 켜요. |
| `npx @the-seeker/madefeed@latest auto off` | 자동 전송을 끄고 실행 파일 복사본과 로그를 지워요. 기기 연결은 유지해요. |
| `npx @the-seeker/madefeed@latest logout` | 서버의 기기 연결을 끊고 이 컴퓨터의 연결 정보와 자동 전송을 지워요. |

| 옵션 | 뜻 |
| --- | --- |
| `--dry-run` | 아무것도 보내지 않고, 보낼 내용을 그대로 보여줘요. |
| `--days N` | 오늘을 포함해 며칠 치를 셀지 정해요. 기본 14, 최대 35예요. |
| `--json` | 결과를 JSON으로만 출력해요. |
| `--url URL` | 서버 주소예요. 기본은 `https://madefeed.dev`예요. |
| `--no-auto` | 이번 실행에서만 자동 전송 등록·갱신을 건너뛰어요. |

## 자동 전송

기기를 연결하면 한 시간마다 최근 3일의 사용량을 자동으로 올려요. 이전 버전에서 연결했다면 다음 `npx @the-seeker/madefeed@latest upload` 실행 때 등록해요. 터미널을 계속 열어 둘 필요가 없어요.

- macOS: `~/Library/LaunchAgents/dev.madefeed.meter.plist`를 launchd에 등록해요. macOS가 **“백그라운드 항목이 추가됨”** 알림을 보여줄 수 있어요.
- Linux: `~/.config/systemd/user/madefeed-meter.service`와 `madefeed-meter.timer`를 등록해요. 사용자 systemd를 사용할 수 없으면 crontab의 `# madefeed-meter` 줄로 실행해요.
- Windows: 작업 스케줄러의 `MadeFeed Meter` 작업과 `~/.config/madefeed/agent/run.cmd`를 등록해요. Windows 경로에서는 `\` 구분자를 사용해요.

실행 파일은 `~/.config/madefeed/agent/cli.mjs`에 복사해 두고 Node.js로 실행해요. 매시간 npx나 npm에 접속하지 않아요. 자동 전송이 켜진 상태에서 `npx @the-seeker/madefeed@latest login` 또는 `npx @the-seeker/madefeed@latest upload`를 실행하면 복사본도 갱신해요. `npx @the-seeker/madefeed@latest status`와 `npx @the-seeker/madefeed@latest auto status`는 조회만 해요. 로그는 `~/.config/madefeed/auto.log`에 남기고, 256 KB를 넘으면 다음 예약 실행 시작 때 마지막 200줄만 남겨요. 토큰과 전송 본문은 로그에 남기지 않아요.

`npx @the-seeker/madefeed@latest auto off`로 끄고, `npx @the-seeker/madefeed@latest auto on`으로 다시 켤 수 있어요. `--no-auto` 또는 `MADEFEED_NO_AUTO=1`은 이번 실행의 등록·갱신만 건너뛰며, 이미 등록한 작업을 끄지는 않아요. `--dry-run`도 등록하지 않아요. 예약 실행에는 `--scheduled`가 붙고, 연결 정보가 없으면 로그인 없이 건너뛰어요. 등록에 실패해도 `npx @the-seeker/madefeed@latest upload`로 직접 올릴 수 있어요.

설치할 때 설정한 `OPENCODE_DATA_DIR`, `XDG_DATA_HOME`, `GEMINI_DATA_DIR`, `MADEFEED_URL`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OMO_CODING_AGENT_DIR`, `OMO_CODING_AGENT_SESSION_DIR`은 예약 작업에도 전달해요.

## 연결 끊기와 정리

`npx @the-seeker/madefeed@latest logout`은 저장된 서버에 기기 연결 해제를 요청하고, agent 디렉터리·`auto.log`·`cli.json`을 지운 뒤 스케줄을 해제해요. 비어 있는 `~/.config/madefeed` 디렉터리도 지워요. 다른 설정 파일과 `~/.config`는 건드리지 않아요. 올린 사용량은 계정에 그대로 남아요. 서버에 닿지 못해도 로컬 정리는 진행하고, 웹에서 연결을 끊을 주소를 알려줘요.

웹에서 기기 연결을 끊거나 계정을 지우면 다음 전송에서 HTTP 401 `unauthorized`를 받은 CLI가 같은 정리를 스스로 해요. 예약 실행은 안내 한 줄을 남기고 정상 종료하며, 직접 실행한 전송은 다시 연결하라는 오류를 보여줘요. 사용량이 0건이어도 요청을 한 번 보내 연결 상태를 확인해요. 이 자가 정리는 0.3.0 이상 복사본에서 동작하므로, 이전 버전은 `npx @the-seeker/madefeed@latest`를 한 번 실행해 갱신해 주세요.

## 보내는 것과 보내지 않는 것

- 보내는 것: 기기 이름, 컴퓨터 식별값의 SHA-256 해시, 날짜, 도구 이름, 모델 이름, 토큰 수
- 보내지 않는 것: 프롬프트, 대화 내용, 코드, 파일 이름과 경로

컴퓨터 식별값은 macOS의 IOPlatformUUID, Linux의 machine-id, Windows의 MachineGuid를 읽고 `madefeed-meter:v1:` 접두어를 붙여 해시해요. 원본 식별값은 출력·전송·저장하지 않아요. 식별값을 읽지 못하면 새 연결은 중단하지만, 이미 연결된 기기는 해시 없이 사용량을 올릴 수 있어요.

`--dry-run`은 컴퓨터 식별값을 읽거나 네트워크에 접속하지 않고, 기기 이름과 사용량 합계만 보여줘요. 실제 연결·전송 때에는 컴퓨터 식별값 해시가 추가돼요.

## 읽는 곳

Claude Code, Codex, OpenCode, Gemini CLI, Pi, oh-my-pi, OmO, Antigravity의 로컬 사용 기록을 읽기 전용으로 읽어요. Antigravity는 CLI 기록만 읽고 IDE의 암호화된 기록은 읽지 않아요. CLI 형식은 공개되지 않아 바뀌면 읽을 수 없는 값을 추측해 세지 않아요. Cursor는 아직 지원하지 않아요.

CLI는 실행 중인 운영체제의 홈을 읽어요. 도구를 WSL에서 실행한다면 CLI도 WSL에서 실행해요. Windows에서 `CODEX_HOME`이나 `CLAUDE_CONFIG_DIR`에 `\\wsl.localhost\Ubuntu\home\me\.codex` 같은 UNC 경로를 쉼표로 구분해 추가할 수 있지만 WSL을 자동으로 찾지는 않아요.

## 개발

이 저장소는 MadeFeed 모노레포의 `packages/cli`를 내보낸 저장소예요. 개발하려면 Node.js 22.15 이상과 pnpm이 필요해요.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

설치할 때 pnpm이 esbuild의 빌드 스크립트를 건너뛰었다고 알려줘도 괜찮아요.

코드는 MadeFeed 모노레포에서 수정한 뒤 이 저장소로 내보내요.

## 라이선스

MIT 라이선스예요. 전문은 `LICENSE` 파일에 있어요.
