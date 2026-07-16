# Kakapo

**AI가 만든 코드를 로컬에서 끝까지 검증하는 데스크톱 리뷰 워크스페이스.**

Kakapo는 채팅의 완료 보고가 아니라 실제 Git 변경 사항, 주변 프로젝트 구조, 언어 서버의 의미 분석을 근거로 리뷰하게 해줍니다. AI가 코드를 수정한 저장소에서 `kakapo`를 실행하고, diff에 질문이나 변경 요청을 남긴 뒤 정확한 파일·라인 정보가 포함된 후속 프롬프트를 복사하면 됩니다.

![Kakapo에서 diff를 검토하고 라인 코멘트를 후속 프롬프트로 만드는 실행 화면](assets/kakapo-core-flow.gif)

## 핵심 흐름

1. AI가 만든 실제 Git diff를 확인합니다.
2. 변경 라인에 질문 또는 변경 요청을 남깁니다.
3. 코멘트를 `@경로#L행` 근거가 포함된 하나의 프롬프트로 합칩니다.
4. 그 프롬프트를 다음 AI 작업에 전달해 수정 결과를 다시 검토합니다.

프로젝트 안에 Kakapo 상태 파일을 만들지 않습니다. 메모, 코멘트, Viewed 상태, UI 상태와 성능 증거는 운영체제의 애플리케이션 데이터 디렉터리에 워크스페이스 절대 경로별로 격리됩니다.

## 주요 기능

- IntelliJ 스타일의 side-by-side diff, 접힌 문맥 확장, hunk 밴드와 F7 탐색
- 변경 파일, 일반 파일, untracked 파일을 포함하는 리뷰 트리
- 파일/프로젝트 검색과 번들된 ripgrep 기반 대형 저장소 검색
- LSP 우선 definition, references, implementation, workspace symbol 탐색
- 호출자·importer·구현체·테스트·타입/API 후보를 구분하는 Change Impact
- 코드 라인 질문/변경 요청과 편집 가능한 합본 프롬프트
- 워크트리별 단일 인라인 Markdown 메모
- 라인 Git 로그와 lane 기반 커밋 그래프
- Markdown, 이미지, HTTP Client 파일의 로컬 리뷰
- 메인 프로세스 검색·인덱싱과 지연 로딩을 통한 대형 프로젝트 대응

Kakapo는 언어 분석기를 새로 구현하지 않습니다. 프로젝트에 설치된 language server를 우선 사용하고, 사용할 수 없는 언어만 정규식 인덱스로 폴백합니다. TypeScript/JavaScript sidecar와 VS Code의 ripgrep 바이너리는 앱에 포함됩니다.

## 설치와 실행

소스에서 설치:

```bash
git clone https://github.com/happy-nut/kakapo.git
cd kakapo
npm install
npm link
```

검토할 Git 저장소 또는 모노레포 내부 폴더에서 실행합니다.

```bash
kakapo
# 또는
kakapo --cwd /path/to/repository/package
```

모노레포 내부 폴더를 열면 Git revision은 상위 저장소에서 읽되 변경 목록, 검색, 소스 탐색과 상태는 선택한 폴더 범위로 제한됩니다.

## 자주 쓰는 단축키

| 단축키 | 동작 |
| --- | --- |
| `Cmd/Ctrl+0` | Changes 패널로 포커스 이동 / 이미 포커스면 토글 |
| `Cmd/Ctrl+1` | Files 패널로 포커스 이동 / 이미 포커스면 토글 |
| `Cmd/Ctrl+F` | 현재 파일 또는 diff 안에서 검색 |
| `Cmd/Ctrl+Shift+F` | 프로젝트 전체 검색 |
| `F7` / `Shift+F7` | 다음 / 이전 diff hunk |
| `Shift+,` | 선택된 변경 파일 Viewed 토글 |
| `Cmd/Ctrl+B` | definition 찾기 |
| `Cmd/Ctrl+Alt+B` | implementation 찾기 |
| `Cmd/Ctrl+8` | Change Impact |
| `Cmd/Ctrl+9` | Git History |
| `Cmd/Ctrl+.` | 현재 괄호 범위 접기 / 펼치기 |
| `Option/Alt+Enter` | 현재 항목의 컨텍스트 액션 |

전체 단축키 목록은 앱의 Settings > Keyboard Shortcuts에서 확인할 수 있습니다.

## 언어 서버

탐색 순서는 다음과 같습니다.

1. `KAKAPO_LSP_<LANGUAGE>`로 지정한 실행 파일
2. 저장소 로컬 실행 파일 (`node_modules/.bin`, `.venv/bin`, `venv/bin`, `bin`)
3. Kakapo에 포함된 TypeScript/JavaScript sidecar
4. 실행 환경의 `PATH`

지원하는 대표 서버는 `typescript-language-server`, `pyright-langserver`/`pylsp`, `gopls`, `rust-analyzer`, `clangd`, `jdtls`, `kotlin-language-server`, `solargraph`, `intelephense`입니다. 서버가 없거나 응답하지 않으면 탐색 기능은 근거 출처를 표시한 정규식 폴백을 사용합니다.

## 로컬 데이터

macOS에서 `/Users/me/repos/zoobox/turtle`을 열었다면 상태는 다음 위치에 저장됩니다.

```text
~/Library/Application Support/Kakapo/workspaces/Users/me/repos/zoobox/turtle/
├── memo.json
├── state.json
├── perf/
└── review/app-review.html
```

경로를 해시로 숨기지 않아 직접 확인할 수 있으며, 저장소 루트와 내부 패키지, 서로 다른 worktree를 동시에 열어도 각각 독립된 상태를 가집니다.

## 개발

```bash
npm install
npm run build
npm test
npm run smoke
```

다른 저장소를 로컬 빌드로 검토:

```bash
npm run dev -- --cwd /path/to/repository
```

README 실행 GIF 재생성:

```bash
npm run demo:gif
```

스크립트는 임시 Git 저장소에 실제 변경을 만들고 Kakapo 리뷰 화면을 Electron에서 실행한 뒤 프레임을 영상으로 인코딩하고 최종 GIF를 생성합니다.

성능 기준 측정:

```bash
npm run benchmark
npm run benchmark -- --files 5000 --changed 200 --lines 120
```

테스트는 실제 임시 Git 저장소와 빌드된 `dist/`를 사용해 diff, 검색, 코멘트, 메모, History, LSP 폴백, 상태 영속화와 Electron 레이아웃의 주요 사용자 흐름을 회귀 검증합니다. 세부 목록은 [test/USER_FLOWS.md](test/USER_FLOWS.md)에 있습니다.

## 설계 원칙

- 채팅 요약보다 실제 diff를 신뢰합니다.
- 확정된 영향과 확인 후보를 구분합니다.
- 리뷰 근거는 파일과 라인에 가깝게 둡니다.
- 상태는 로컬에 평문 Markdown/JSON/HTML로 보존합니다.
- 특정 AI, 에디터 플러그인, worktree 전략이나 호스팅 서비스에 종속되지 않습니다.

## License

MIT
