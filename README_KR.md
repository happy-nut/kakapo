# Kakapo

**AI가 실제로 무엇을 바꿨는지 읽는 데스크톱 diff 리더. 작업 중인 저장소에서 터미널로 실행합니다.**

*[English README](README.md)*

코딩 에이전트는 빠릅니다. 그 결과물을 읽는 쪽이 느리죠. Kakapo는 그 반쪽을 위해 만들어졌습니다 — 진짜 diff, 진짜 language server 탐색, 코드 옆에 남는 리뷰 코멘트.

## 왜 Kakapo인가

**근거는 채팅 로그가 아니라 diff입니다.** 에이전트의 "완료 ✅"는 주장일 뿐입니다. Kakapo는 실제 Git diff를 IntelliJ 스타일 side-by-side로 열고, 접힌 문맥을 펼치고, `F7`로 hunk를 넘기고, 파일별 *Viewed* 상태를 남깁니다. 보고된 내용이 아니라 들어온 변경을 봅니다.

**코멘트는 코드 옆에 남습니다.** 라인에서 `?`를 눌러 질문이나 변경 요청을 남깁니다 — 한 라인에 코멘트는 하나입니다. 이미 코멘트가 있는 라인에서 다시 `?`를 누르면 새로 쌓이는 대신 그 코멘트가 열립니다. `F8`로 열린 스레드를 끝까지 훑고, `⌘⇧/`로 열린 코멘트 전체를 한 문서로 모아 복사합니다 — 앞에 붙는 지시문 없이 코멘트만. 에이전트가 있는 곳에 붙여넣으면 됩니다. 스레드 자체는 평문 파일이라, 그 경로를 받은 에이전트는 답변을 질문한 카드 위로 되돌려 붙일 수 있습니다.

**설치 없이 IDE 수준으로 읽습니다.** definition·references·implementation·workspace symbol이 실제 language server로 diff 위에서 동작하고, Semantic Peek이 리뷰를 벗어나지 않고 그 자리에서 답을 보여줍니다. 프로젝트 검색은 번들된 ripgrep으로 돌아갑니다. 9개 언어의 분석기와 실행 환경이 앱 안에 들어 있어 `PATH`도, 별도 설치도, 에디터 플러그인도 필요 없습니다.

**추적되는 프로젝트 파일에는 아무것도 쓰지 않습니다.** 리뷰 스레드는 `.git/` 안에 있습니다 — git은 자기 디렉터리를 추적하지 않으니 `git status`는 깨끗하고, cwd에 갇힌 코딩 에이전트도 그 파일에 닿을 수 있습니다. 나머지 상태는 워크스페이스 절대 경로별로 OS 애플리케이션 데이터 디렉터리에 격리됩니다. 전부 평문 JSONL/Markdown/JSON, 완전 로컬, 계정도 텔레메트리도 없고 MIT입니다.

## 리뷰 루프

1. 에이전트는 사용자의 터미널에서 작업합니다.
2. 그 저장소에서 `kakapo`를 실행해 diff를 읽습니다 — `F7`로 hunk 이동, `Space`로 파일 확인 표시.
3. 라인에서 `?`로 질문하거나 변경을 요청합니다.
4. `⌘⇧/`로 열린 코멘트 전체를 한 문서로 모으고, 복사해서 에이전트가 있는 곳에 붙여넣습니다.

## 설치

### macOS (Apple Silicon)

[Releases](https://github.com/happy-nut/kakapo/releases)에서 `Kakapo-<version>-arm64.dmg`를 받습니다. 서명되지 않은 빌드라 첫 실행은 우클릭 → **열기**로 Gatekeeper를 통과해야 합니다.

### Linux (x64 / ARM64)

모든 PR, `main` 변경, 릴리스에서 각 아키텍처의 네이티브 Ubuntu runner가 전체 테스트를 돌리고, 앱을 패키징하고, Xvfb에서 실제 Chromium 렌더러가 열리는 것까지 확인합니다. 이 검증을 통과한 빌드만 게시됩니다.

```bash
tar -xzf Kakapo-<version>-linux-x64.tar.gz
./Kakapo-linux-x64/Kakapo --cwd /path/to/repository
```

ARM에서는 `x64`를 `arm64`로 바꿉니다. 별도의 Electron, Node.js, language server, JRE, PHP, Go/Rust toolchain을 설치할 필요가 없습니다.

### Windows (x64)

[Releases](https://github.com/happy-nut/kakapo/releases)에서 `Kakapo-<version>-windows-x64.zip`을 받아 풀고 `Kakapo.exe`를 실행합니다. 서명되지 않은 빌드라 첫 실행은 SmartScreen에서 **추가 정보 → 실행**을 눌러야 합니다. TypeScript·Python language server는 번들되어 있고, 나머지 7개 언어는 `PATH`의 서버를 쓰거나 정규식 인덱스로 폴백합니다.

### 소스에서

Node.js 22.14 이상이 필요합니다.

```bash
git clone https://github.com/happy-nut/kakapo.git
cd kakapo
npm install
npm run lsp:install
npm link
kakapo install-app   # 선택: Applications에 Kakapo 아이콘 추가
```

`npm`이 설치하는 건 명령어이지 애플리케이션이 아니라서, kakapo는 터미널에만 있고 Spotlight·Launchpad에는
뜨지 않습니다. `kakapo install-app`이 Applications에 아이콘을 만들어 줍니다 — 방금 설치한 그 CLI를 그대로
실행하는 런처라 따로 관리할 사본이 생기지 않고, `kakapo uninstall-app`으로 지웁니다.

## 실행

Git 저장소나 모노레포 내부 패키지 폴더에서 실행합니다.

```bash
kakapo
kakapo /path/to/repository/package     # 또는 아무 폴더나
kakapo path/to/file.ts                 # 그 파일이 있는 폴더를 열고 파일에 바로 안착
```

Git은 선택입니다. 저장소가 아닌 폴더는 diff가 빈 소스 트리로 열립니다 — 커밋할 생각이 없던 파일을 읽을
때가 그렇습니다. `~/.claude` 밑의 설계 메모, 임시 폴더, 풀어 놓은 tarball 같은 것들.

Kakapo는 한 번만 실행됩니다. 같은 저장소나 worktree에서 다시 실행하면 이미 그것을 리뷰 중인 창으로 이동하고, 다른 저장소는 자기 창을 엽니다. 하위 폴더는 Git top-level로 정규화되므로 같은 checkout이 두 번 열리지 않고, 서로 다른 worktree는 각각 독립된 창으로 남습니다.

### 비교 대상 고르기

툴바의 pill이 지금 무엇을 비교 중인지 말해 주고, 누르면 하루 종일 오가게 되는 두 상태가 열립니다.

| 키 | |
| --- | --- |
| `⌥A` | 이 브랜치의 모든 변경 — 고른 브랜치와의 merge-base 기준 |
| `⌥U` | 아직 커밋하지 않은 것만 |
| `⌥C` | 그 브랜치 고르기 — 목록에서 검색하거나 저장소 기본값 그대로 |

"모든 변경사항"은 브랜치 tip이 아니라 **merge-base**를 씁니다. 그냥 `git diff main`을 하면, 그사이 움직인 `main`의 남의 커밋이 내가 지운 것처럼 보이기 때문입니다.

아무 플래그 없이 열면 kakapo가 알아서 고릅니다 — push하지 않은 커밋이 있으면 upstream의 merge-base, 아니면 `HEAD`. 실행할 때 직접 지정할 수도 있습니다.

```bash
kakapo --base main          # working tree vs main (AI 피처 브랜치 전체 리뷰)
kakapo --base v0.2.0        # 특정 태그와 비교
kakapo --base 9f3c1a2       # 특정 커밋과 비교
kakapo --staged             # 인덱스 vs HEAD
```

`kakapo --help`에 전체 플래그가 있습니다. `--base`는 어떤 revision이든 받고 실행 시점에 검증하며, `--staged`와는 함께 쓸 수 없습니다. 드롭다운보다 더 좁게 잘라 보고 싶다면, 툴바 아래 patch set 바가 브랜치의 커밋 하나와 다른 하나를 직접 비교하고, `⌘9`로 커밋 그래프를 열어 Enter를 누르면 그 커밋이 메인 리뷰에서 열립니다.

## 단축키

| 키 | 동작 |
| --- | --- |
| `⌘0` / `⌘1` | 변경사항 / 파일 패널 |
| `F7` / `⇧F7` | 다음 / 이전 변경 hunk |
| `Space` | 선택한 변경 파일 Viewed 토글 |
| `?` | 현재 라인에 코멘트 |
| `F8` / `⇧F8` | 다음 / 이전 코멘트 |
| `⌘⇧/` | 리뷰 코멘트 전체 (인계 문서) |
| `⌘9` | Git 히스토리 |
| `⌘F` / `⌘⇧F` | 파일 안 검색 / 프로젝트 검색 (⌘⇧F 좌측 목록에 파일 찾기·최근 파일) |
| `⌘E` | 최근 파일 — 목록만 단독으로, 다시 누르면 닫힘. 타이핑하면 필터되고, 한글로 쳐도 두벌식 영타로 바꿔 함께 검색 |
| `⌥A` / `⌥U` | 모든 변경사항 / 커밋되지 않은 변경사항 |
| `⌥C` | "모든 변경사항"의 비교 대상 브랜치 고르기 |
| `⌘B` / `⌘⌥B` / `⌘⌥O` | 사용처 찾기 / implementation / workspace symbol |
| `⌘↓` / `⌘`+클릭 | 정의로 이동 |
| `⌘,` | 설정 |

나머지는 설정 ▸ 단축키에 있습니다.

## 내장 language server

| 언어 | 분석기 | 함께 들어 있는 실행 환경 |
| --- | --- | --- |
| TypeScript / JavaScript | `typescript-language-server` | Electron의 Node 호스트 |
| Python | Pyright | Electron의 Node 호스트 |
| Go | `gopls` | Go SDK |
| Rust | `rust-analyzer` | Cargo, Rust stable, `rust-src` |
| C / C++ | `clangd` | 플랫폼 네이티브 clangd |
| Java | Eclipse JDT LS | Temurin JRE 21 |
| Kotlin | JetBrains Kotlin LSP | 전용 JetBrains Runtime |
| Ruby | Sorbet | 플랫폼 네이티브 Sorbet |
| PHP | Phpactor | 정적 PHP 8.4 런타임 |

배포본은 항상 자기 번들을 우선하며 셸의 `PATH`는 뒤지지 않습니다. 명시한 `KAKAPO_LSP_<LANGUAGE>` 실행 파일만 이를 덮어쓸 수 있고, 번들을 아직 설치하지 않은 소스 체크아웃에서만 저장소 로컬 실행 파일을 개발 폴백으로 허용합니다. 패키징은 9개 번들의 존재와 실제 cross-file definition을 모두 확인한 뒤에만 진행됩니다. 지원 밖 언어이거나 서버가 답하지 못하면, 출처가 표시된 정규식 인덱스로 폴백합니다.

의미 분석의 품질은 프로젝트 메타데이터에도 달려 있습니다 — Java/Kotlin은 Maven·Gradle 모델, Rust는 `Cargo.toml`, Go는 `go.mod`, 큰 C/C++ 프로젝트는 `compile_commands.json`, PHP는 Composer autoload. 분석 캐시와 JDT/Kotlin workspace는 저장소 안이 아니라 임시·앱 데이터 영역에 둡니다.

## 상태가 저장되는 곳

리뷰 스레드는 저장소의 git 디렉터리 안에 있습니다.

```text
.git/worktrees/<name>/kakapo/comments.jsonl   # 이 worktree의 리뷰 대화
```

나머지는 워크스페이스 절대 경로별로 OS 앱 데이터 디렉터리에 미러링됩니다. macOS에서 `/Users/me/repos/acme/turtle`을 열었다면:

```text
~/Library/Application Support/Kakapo/workspaces/Users/me/repos/acme/turtle/
├── state.json
├── perf/
└── review/app-review.html
```

경로를 해시로 숨기지 않아 직접 열어볼 수 있고, 저장소 루트·내부 패키지·다른 worktree를 동시에 열어도 각각 독립된 상태를 가집니다. Linux에서는 같은 구조가 `${XDG_CONFIG_HOME:-~/.config}/Kakapo/workspaces/...` 아래에 있습니다.

## 개발

```bash
npm install
npm run lsp:install
npm run build
npm run lsp:smoke
npm test
npm run smoke
```

로컬 빌드로 다른 저장소를 검토:

```bash
npm run dev -- --cwd /path/to/repository
```

Linux 패키지 생성과 실제 렌더러 확인:

```bash
npm run dist:linux:x64   # 또는 dist:linux:arm64
npm run smoke:linux
```

플랫폼별 optional dependency가 빠진 교차 빌드를 배포하지 않도록, Linux 패키지는 대상과 같은 아키텍처의 Linux 호스트에서만 만들어집니다. macOS에서 실행하면 불완전한 산출물을 만들지 않고 바로 실패합니다. macOS 빌드는 `npm run dist:mac:dmg`로 만듭니다.

성능은 `npm run benchmark`(`-- --files 5000 --changed 200 --lines 120`으로 더 큰 합성 저장소)로 측정합니다.

테스트는 실제 임시 Git 저장소와 빌드된 `dist/`를 사용해 diff, 검색, 코멘트, 히스토리, LSP 폴백, 상태 영속화, Electron 레이아웃을 회귀 검증합니다. 사용자 흐름 목록은 [test/USER_FLOWS.md](test/USER_FLOWS.md)에 있습니다.

## 설계 원칙

- 채팅 요약보다 실제 diff를 신뢰합니다.
- 확정된 영향과 확인이 필요한 후보를 구분합니다.
- 리뷰 근거는 파일과 라인 곁에 둡니다.
- 상태는 로컬에 평문 Markdown/JSON/JSONL로 남깁니다.
- 특정 AI, 에디터 플러그인, worktree 전략, 호스팅 서비스에 종속되지 않습니다.

## 라이선스

MIT
