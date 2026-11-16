# @the-seeker/madefeed

[MadeFeed](https://madefeed.dev) 토큰 미터예요. 이 컴퓨터에서 AI 코딩 도구로 쓴 토큰 합계를 읽어 MadeFeed 계정에 올려요. 올린 토큰만큼 제품에 투표할 표가 생겨요.

## 쓰는 법

```sh
npx @the-seeker/madefeed@latest
```

처음 실행하면 브라우저에서 기기를 연결하고, 이어서 사용량을 올려요. Node.js 22.13 이상이 필요해요.

| 명령 | 하는 일 |
| --- | --- |
| `madefeed` 또는 `madefeed upload` | 연결이 없으면 연결하고, 사용량을 올려요. |
| `madefeed login` | 기기만 연결해요. |
| `madefeed status` | 연결과 자동 전송 상태를 보여줘요. |
| `madefeed auto [status]` | 자동 전송 상태를 보여줘요. `--json`도 지원해요. |
| `madefeed auto on` | 연결된 기기의 자동 전송을 켜요. |
| `madefeed auto off` | 자동 전송을 끄고 실행 파일 복사본을 지워요. |
| `madefeed logout` | 자동 전송을 해제하고 이 기기의 로컬 연결을 지워요. |

| 옵션 | 뜻 |
| --- | --- |
| `--dry-run` | 아무것도 보내지 않고, 보낼 내용을 그대로 보여줘요. |
| `--days N` | 오늘을 포함해 며칠 치를 셀지 정해요. 기본 14, 최대 35예요. |
| `--json` | 결과를 JSON으로만 출력해요. |
| `--url URL` | 서버 주소예요. 기본은 `https://madefeed.dev`예요. |
| `--no-auto` | 이번 실행에서만 자동 전송 등록·갱신을 건너뛰어요. |

## 자동 전송

기기를 연결하면 한 시간마다 최근 3일의 사용량을 자동으로 올려요. 이전 버전에서 연결했다면 다음 `upload` 실행 때 등록해요. 터미널을 계속 열어 둘 필요가 없어요.

- macOS: `~/Library/LaunchAgents/dev.madefeed.meter.plist`를 launchd에 등록해요. macOS가 **“백그라운드 항목이 추가됨”** 알림을 보여줄 수 있어요.
- Linux: `~/.config/systemd/user/madefeed-meter.service`와 `madefeed-meter.timer`를 등록해요. 사용자 systemd를 사용할 수 없으면 crontab의 `# madefeed-meter` 줄로 실행해요.
- Windows: 작업 스케줄러의 `MadeFeed Meter` 작업과 `~/.config/madefeed/agent/run.cmd`를 등록해요. Windows 경로에서는 `\` 구분자를 사용해요.

실행 파일은 `~/.config/madefeed/agent/cli.mjs`에 복사해 두고 Node.js로 실행해요. 매시간 npx나 npm에 접속하지 않아요. 자동 전송이 켜진 상태에서 새 CLI로 `login` 또는 `upload`를 실행하면 복사본도 갱신해요. `status`와 `auto status`는 조회만 해요. 로그는 `~/.config/madefeed/auto.log`에 남기고, 256 KB를 넘으면 다음 예약 실행 시작 때 마지막 200줄만 남겨요. 토큰과 전송 본문은 로그에 남기지 않아요.

`madefeed auto off`로 끄고, `madefeed auto on`으로 다시 켤 수 있어요. `--no-auto` 또는 `MADEFEED_NO_AUTO=1`은 이번 실행의 등록·갱신만 건너뛰며, 이미 등록한 작업을 끄지는 않아요. `--dry-run`도 등록하지 않아요. 예약 실행에는 `--scheduled`가 붙고, 연결 정보가 없으면 로그인 없이 건너뛰어요. 등록에 실패해도 `madefeed upload`로 수동 전송할 수 있어요.

설치할 때 설정한 `OPENCODE_DATA_DIR`, `XDG_DATA_HOME`, `GEMINI_DATA_DIR`, `MADEFEED_URL`은 예약 작업에도 전달해요. `logout`은 스케줄·agent 디렉터리·`cli.json`만 지우고 다른 설정 파일과 로그는 남겨요.

## 보내는 것과 보내지 않는 것

- 보내는 것: 기기 이름, 날짜, 도구 이름, 모델 이름, 토큰 수
- 보내지 않는 것: 프롬프트, 대화 내용, 코드, 파일 이름과 경로

`--dry-run`으로 실제로 보낼 내용을 먼저 확인할 수 있어요.

## 읽는 곳

Claude Code, Codex, OpenCode, Gemini CLI의 로컬 사용 기록을 읽기 전용으로 읽어요. Cursor는 아직 지원하지 않아요.
