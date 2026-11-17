import type { Device, UploadResult } from './api'
import type { Config } from './config'
import type { ScheduleStatus } from './schedule'

export const RUN = 'npx @the-seeker/madefeed@latest'
export const setupFailure = `자동 전송을 등록하지 못했어요. ${RUN} 로 직접 올릴 수 있어요.`
// Names the command for the scope that failed: retrying logout after a failed
// auto off would also disconnect the device.
export const cleanupFailure = (scope: 'auto' | 'device') =>
  `지우지 못한 파일이 있어요. ${RUN} ${scope === 'auto' ? 'auto off' : 'logout'} 을 한 번 더 실행해 주세요.`
export const autoEnabled = [
  '한 시간마다 자동으로 올려요. 터미널을 열어 두지 않아도 돼요.',
  `  자동 전송 끄기  ${RUN} auto off`,
  `  연결 끊기       ${RUN} logout`,
] as const
export const connectionRequired = `먼저 ${RUN} 로 기기를 연결해 주세요.`
export const invalidAuto = 'auto on, off, status 중 하나를 사용해 주세요.'
export const invalidDays = '--days는 1~35 사이의 정수여야 해요.'
export const unknownCommand = '알 수 없는 명령이에요. --help를 확인해 주세요.'
export const invalidDryRun =
  '--dry-run은 기본 실행 또는 upload에서만 사용할 수 있어요.'
export const invalidScheduled = '--scheduled는 upload에서만 사용할 수 있어요.'
export const invalidOptions =
  '명령 옵션이 올바르지 않아요. --help를 확인해 주세요.'
export const invalidUrl = '서버 URL이 올바르지 않아요.'
export const unsafeUrl = '서버 URL은 인증 정보 없는 HTTPS origin이어야 해요.'
export const invalidConfig = `설정 파일이 올바르지 않아요. ${RUN} login 으로 다시 연결해 주세요.`
export const scheduledSkip = '연결된 기기가 없어 자동 전송을 건너뛰었어요.'
export const dryRunHeader =
  '전송하지 않았어요. 아래 합계와 JSON만 전송 대상이에요.'
export const dryRunColumns =
  'date        tool         model                         tokens'
export const localFailure =
  '로컬 사용량 또는 설정을 처리할 수 없어요. 접근 권한과 Node.js 버전을 확인해 주세요.'
export const disconnected = `서버에서 이 기기 연결이 끊겨 있어요. 자동 전송과 이 컴퓨터의 연결 정보를 지웠어요. 다시 연결하려면 ${RUN} 를 실행해 주세요.`
export const logoutRevoked =
  '연결을 끊었어요. 자동 전송과 이 컴퓨터의 연결 정보를 지웠어요. 올린 사용량은 계정에 그대로 남아요.'
export const logoutLocal = '이 컴퓨터의 연결 정보와 자동 전송을 지웠어요.'
export const logoutUnreachable = (url: string) =>
  `이 컴퓨터의 연결 정보와 자동 전송은 지웠어요. 서버에는 닿지 못했으니 ${url}/meter 에서 이 기기 연결을 끊어 주세요.`
export const scheduledDisconnected = (now: number) =>
  `${new Date(now).toISOString()} 서버에서 이 기기 연결이 끊겨 자동 전송을 해제하고 연결 정보를 지웠어요.`
export const connected = (deviceName: string) =>
  `${deviceName} 기기를 연결했어요.`
export const approval = (device: Device) => [
  '브라우저에서 아래 주소를 열고, 코드가 같으면 승인해 주세요.',
  `  주소  ${device.verification_uri}`,
  `  코드  ${device.user_code}`,
]
export const autoLine = (state: ScheduleStatus) =>
  state.enabled
    ? `자동 전송: 켜져 있어요 (한 시간마다, ${state.kind}).`
    : '자동 전송: 꺼져 있어요.'
export const connectionLine = (config: Config | undefined) =>
  config
    ? `연결: ${config.deviceName} (${config.url})`
    : `연결: 아직 연결하지 않았어요. ${RUN} 로 연결해 주세요.`
export function uploadResult(result: UploadResult): string {
  const lines = [
    `사용량 ${result.accepted}건을 올렸어요.${result.ignored > 0 ? ` 제외한 기록 ${result.ignored}건.` : ''}${result.votesGranted > 0 ? ` 새로 받은 표 ${result.votesGranted}표.` : ''}`,
  ]
  switch (result.backfill) {
    case 'applied':
      lines.push('처음 연결이라 지난 30일 사용량도 합산했어요.')
      break
    case 'closed':
      lines.push(
        '이 계정은 지난 사용량을 이미 한 번 합산해서, 연결 전 기록은 빼고 올렸어요.',
      )
      break
    case null:
      break
    default: {
      const unreachable: never = result.backfill
      return unreachable
    }
  }
  if (result.bankVotes !== undefined)
    lines.push(`누적 표 ${result.bankVotes}표.`)
  return lines.join('\n')
}
export const scheduledUpload = (now: number, result: UploadResult) =>
  `${new Date(now).toISOString()} 사용량 ${result.accepted}건을 올렸어요.${result.ignored > 0 ? ` 제외한 기록 ${result.ignored}건.` : ''}`
export const apiFailure = (status: number) =>
  status === 401
    ? `HTTP 401: 기기 연결이 유효하지 않아요. ${RUN} login 으로 다시 연결해 주세요.`
    : status === 422
      ? 'HTTP 422: 사용량 형식이 서버 규칙과 맞지 않아요.'
      : `HTTP ${status}: 서버 요청에 실패했어요.`
export const expiredCode = `기기 인증 코드가 만료됐어요. ${RUN} login 을 다시 실행해 주세요.`
export const invalidCode = `유효하지 않은 인증 코드예요. ${RUN} login 을 다시 실행해 주세요.`

export function helpText(version: string): string {
  return `madefeed ${version} — MadeFeed 토큰 미터
사용법: ${RUN} [명령] [옵션]

명령
  (없음), upload          연결이 없으면 연결하고, 사용량을 올려요.
  login                   기기를 연결하고 지난 30일 사용량을 올려요.
  status                  연결과 자동 전송 상태를 보여줘요.
  auto [on|off|status]    자동 전송을 켜거나 끄거나 확인해요.
  logout                  연결을 끊고 이 컴퓨터의 연결 정보와 자동 전송을 지워요.

옵션
  --dry-run    보내지 않고, 보낼 합계와 요청 JSON만 보여줘요.
  --days N     오늘을 포함해 며칠 치를 셀지 정해요. 기본 14, 최대 35 (KST).
               첫 연결·이전 버전의 첫 전송은 30일이에요. --dry-run은 예외예요.
  --url URL    서버 주소예요. 기본은 MADEFEED_URL 또는 https://madefeed.dev.
  --json       기계가 읽을 JSON만 표준 출력으로 내보내요.
  --no-auto    이번 실행에서는 자동 전송을 등록하거나 갱신하지 않아요.
  --scheduled  예약 작업용이에요. 연결 절차 없이 올려요.
  --help       도움말을 보여줘요.
  --version    버전을 보여줘요.

지난 사용량 합산은 계정당 한 번이며, 결과에 남은 누적 표를 보여줘요.
login --json은 loggedIn과 전송 결과를 담은 JSON 객체 하나를 출력해요.
읽는 도구: Claude Code, Codex, OpenCode, Gemini CLI (Cursor는 아직 지원하지 않아요)`
}
