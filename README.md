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
| `madefeed status` | 연결 상태를 보여줘요. |
| `madefeed logout` | 이 기기의 연결을 지워요. |

| 옵션 | 뜻 |
| --- | --- |
| `--dry-run` | 아무것도 보내지 않고, 보낼 내용을 그대로 보여줘요. |
| `--days N` | 오늘을 포함해 며칠 치를 셀지 정해요. 기본 14, 최대 35예요. |
| `--json` | 결과를 JSON으로만 출력해요. |
| `--url URL` | 서버 주소예요. 기본은 `https://madefeed.dev`예요. |

## 보내는 것과 보내지 않는 것

- 보내는 것: 기기 이름, 날짜, 도구 이름, 모델 이름, 토큰 수
- 보내지 않는 것: 프롬프트, 대화 내용, 코드, 파일 이름과 경로

`--dry-run`으로 실제로 보낼 내용을 먼저 확인할 수 있어요.

## 읽는 곳

Claude Code, Codex, OpenCode, Gemini CLI의 로컬 사용 기록을 읽기 전용으로 읽어요. Cursor는 아직 지원하지 않아요.
