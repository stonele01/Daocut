/**
 * What each release brings, said to the person after an update: a few lines a release, in every language Studio
 * speaks (a release without them all does not compile), grouped as new, improved and fixed. The newest first.
 *
 * Written when a release is made (the "Version packages" pull request): the changesets say everything that changed,
 * for the changelog; these say what a person would notice, in their words, at most six lines. A version without them
 * fails the tests (whats-new.test.ts), so that pull request cannot be merged until they are written.
 *
 * After an update the release notes since the version last shown appear once (lib's notesToShow; Studio's prefs keep
 * `seenVersion`). A new install shows none: there is nothing it was updated from.
 */
import type { Language } from '@/i18n';

export type NoteKind = 'new' | 'improved' | 'fixed';
export interface ReleaseNote { kind: NoteKind; text: string }
export interface ReleaseNotes { version: string; date: string; notes: Record<Language, ReleaseNote[]> }

export const RELEASES: readonly ReleaseNotes[] = [
  {
    "version": "0.2.21",
    "date": "2026-10-27",
    "notes": {
      "en": [
        {
          "kind": "improved",
          "text": "Live commerce skill 1.0.4 reuses verified source analysis across cuts and avoids repeated reads and tool calls without progress."
        },
        {
          "kind": "improved",
          "text": "Existing editing standards remain in place; local revisions recheck affected content and joins, and every distinct supported cut is still completed and verified."
        }
      ],
      "zh-CN": [
        {
          "kind": "improved",
          "text": "带货切片 Skill 升级到 1.0.4，复用已核实素材分析，减少重复读取和无进展工具调用。"
        },
        {
          "kind": "improved",
          "text": "保留原有剪辑要求，局部修改复查受影响内容及接缝，仍完成并检查素材支持的全部独立切片。"
        }
      ],
      "ja": [
        {
          "kind": "improved",
          "text": "ライブコマース編集スキルを 1.0.4 に更新。確認済みの素材分析を再利用し、重複した読み込みや進展のないツール操作を減らします。"
        },
        {
          "kind": "improved",
          "text": "従来の編集基準を維持。部分修正では影響箇所と接続を再確認し、素材で成立する異なる切り口をすべて仕上げて検証します。"
        }
      ],
      "ko": [
        {
          "kind": "improved",
          "text": "라이브 커머스 편집 스킬을 1.0.4로 업데이트했습니다. 확인된 원본 분석을 재사용하고 반복 읽기와 진전 없는 도구 호출을 줄입니다."
        },
        {
          "kind": "improved",
          "text": "기존 편집 기준을 유지합니다. 부분 수정 시 영향받은 내용과 연결부를 재검토하고, 원본이 뒷받침하는 모든 독립 클립을 완성하고 확인합니다."
        }
      ],
      "es": [
        {
          "kind": "improved",
          "text": "La habilidad de edición de comercio en directo pasa a 1.0.4: reutiliza el análisis verificado y reduce lecturas repetidas y llamadas sin progreso."
        },
        {
          "kind": "improved",
          "text": "Se mantienen los criterios de edición. Los cambios locales revisan el contenido afectado y sus enlaces; se completan y verifican todos los cortes distintos que sustenta el material."
        }
      ]
    }
  },
  {
    "version": "0.2.20",
    "date": "2026-10-26",
    "notes": {
      "en": [
        {
          "kind": "improved",
          "text": "Editing guidance now focuses on the requested result, reuses existing analysis and loads relevant skills and command help as needed."
        },
        {
          "kind": "fixed",
          "text": "Reopening or resuming an own-key chat keeps unchanged skill references stable for model prompt caching."
        }
      ],
      "zh-CN": [
        {
          "kind": "improved",
          "text": "剪辑指引按交付要求执行，复用已有分析，按需读取匹配技能和命令帮助。"
        },
        {
          "kind": "fixed",
          "text": "自填 API 对话重开或恢复时，保持未变化的技能引用稳定，减少对模型缓存前缀的影响。"
        }
      ],
      "ja": [
        {
          "kind": "improved",
          "text": "編集ガイドは依頼された成果物に集中し、既存の分析を再利用して、関連スキルやコマンドのヘルプを必要なときに読み込みます。"
        },
        {
          "kind": "fixed",
          "text": "独自 API キーのチャットを再開・復元しても、変更のないスキル参照を安定させ、プロンプトのキャッシュを利用しやすくしました。"
        }
      ],
      "ko": [
        {
          "kind": "improved",
          "text": "편집 안내가 요청한 결과에 집중하고 기존 분석을 재사용하며, 관련 스킬과 명령 도움말을 필요할 때 읽습니다."
        },
        {
          "kind": "fixed",
          "text": "자체 API 키 채팅을 다시 열거나 복원할 때 변경되지 않은 스킬 참조를 유지하여 프롬프트 캐시를 활용할 수 있도록 했습니다."
        }
      ],
      "es": [
        {
          "kind": "improved",
          "text": "La guía de edición se centra en el resultado solicitado, reutiliza análisis y consulta habilidades y ayuda de comandos cuando hace falta."
        },
        {
          "kind": "fixed",
          "text": "Al reabrir o reanudar un chat con API propia, las referencias a habilidades sin cambios se mantienen estables para la caché del modelo."
        }
      ]
    }
  },
  {
    "version": "0.2.19",
    "date": "2026-10-26",
    "notes": {
      "en": [
        {
          "kind": "fixed",
          "text": "Feedback logs replace embedded image data with references and preserve request and failure records within the size limit."
        },
        {
          "kind": "fixed",
          "text": "The official DeepSeek Responses connection now sends system instructions using its supported message role."
        },
        {
          "kind": "improved",
          "text": "Live commerce editing rules 1.0.3 reuse prior analysis for local changes, keep complete sales arguments and make distinct cuts as separate films."
        },
        {
          "kind": "improved",
          "text": "Editing guidance now checks the available tools and validates timelines before reporting completion."
        }
      ],
      "zh-CN": [
        {
          "kind": "fixed",
          "text": "反馈日志用引用替代内嵌图片数据，在大小限制内保留请求与错误记录。"
        },
        {
          "kind": "fixed",
          "text": "修正 DeepSeek 官方 Responses 接口的系统指令消息角色兼容。"
        },
        {
          "kind": "improved",
          "text": "带货剪辑规则升级到 1.0.3，局部修改复用已有分析，保留完整说服结构，不同切片分别成片。"
        },
        {
          "kind": "improved",
          "text": "剪辑指引对齐实际工具，并在交付前检查时间轴。"
        }
      ],
      "ja": [
        {
          "kind": "fixed",
          "text": "フィードバックログの画像データを参照に置き換え、容量制限内で依頼とエラーの記録を保持します。"
        },
        {
          "kind": "fixed",
          "text": "DeepSeek 公式 Responses 接続で、システム指示を対応するメッセージロールで送信します。"
        },
        {
          "kind": "improved",
          "text": "ライブコマース編集ルール 1.0.3 は部分修正で既存の分析を再利用し、訴求の流れを保ち、異なるカットを別々の動画にします。"
        },
        {
          "kind": "improved",
          "text": "編集ガイドを実際のツールに合わせ、完了報告前にタイムラインを確認します。"
        }
      ],
      "ko": [
        {
          "kind": "fixed",
          "text": "피드백 로그에서 이미지 데이터를 참조로 바꾸고 용량 제한 안에서 요청과 오류 기록을 보존합니다."
        },
        {
          "kind": "fixed",
          "text": "DeepSeek 공식 Responses 연결에서 지원되는 메시지 역할로 시스템 지침을 전송합니다."
        },
        {
          "kind": "improved",
          "text": "라이브 커머스 편집 규칙 1.0.3은 부분 수정 시 기존 분석을 재사용하고 설득 흐름을 유지하며 서로 다른 컷을 별도 영상으로 만듭니다."
        },
        {
          "kind": "improved",
          "text": "편집 안내를 실제 도구에 맞추고 완료 보고 전에 타임라인을 확인합니다."
        }
      ],
      "es": [
        {
          "kind": "fixed",
          "text": "Los registros de comentarios sustituyen las imágenes incrustadas por referencias y conservan solicitudes y errores dentro del límite de tamaño."
        },
        {
          "kind": "fixed",
          "text": "La conexión oficial de DeepSeek Responses envía las instrucciones del sistema con el rol de mensaje compatible."
        },
        {
          "kind": "improved",
          "text": "Las reglas de edición de comercio en directo 1.0.3 reutilizan análisis para cambios locales, conservan argumentos completos y crean vídeos separados para cortes distintos."
        },
        {
          "kind": "improved",
          "text": "La guía de edición coincide con las herramientas disponibles y comprueba la línea de tiempo antes de informar que ha terminado."
        }
      ]
    }
  },
  {
    version: '0.2.18', date: '2026-10-26', notes: {
      'en': [
        { kind: 'new', text: 'Administrators can set daily and monthly employee Token limits in the company console.' },
        { kind: 'improved', text: 'API requests reserve quota first and settle against reported usage, including summaries and retries.' },
        { kind: 'improved', text: 'When quota is insufficient, new AI requests pause while completed edits and manual editing or export remain available.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '公司管理台支持设置员工每日、每月 Token 额度，并查看已用、预占和剩余。' },
        { kind: 'improved', text: 'API 请求先预留额度，再按实际用量结算，摘要和重试也计入。' },
        { kind: 'improved', text: '额度不足时暂停新的 AI 请求，保留已完成的剪辑，手动编辑和导出照常。' },
      ],
      'ja': [
        { kind: 'new', text: '会社の管理画面で従業員ごとの日次・月次 Token 上限を設定できます。' },
        { kind: 'improved', text: 'API リクエストは枠を予約し、実際の使用量で精算します。要約と再試行も対象です。' },
        { kind: 'improved', text: '残り枠が不足すると新しい AI リクエストを停止します。編集済み内容、手動編集、書き出しはそのまま利用できます。' },
      ],
      'ko': [
        { kind: 'new', text: '회사 관리 화면에서 직원별 일일 및 월간 Token 한도를 설정할 수 있습니다.' },
        { kind: 'improved', text: 'API 요청 전에 한도를 예약하고 실제 사용량으로 정산합니다. 요약과 재시도도 포함합니다.' },
        { kind: 'improved', text: '잔여 한도가 부족하면 새 AI 요청을 중지합니다. 완료된 편집과 수동 편집 및 내보내기는 유지됩니다.' },
      ],
      'es': [
        { kind: 'new', text: 'La consola permite configurar límites diarios y mensuales de Token por empleado.' },
        { kind: 'improved', text: 'Las solicitudes API reservan cuota y se liquidan con el uso informado, incluidos los resúmenes y reintentos.' },
        { kind: 'improved', text: 'Sin cuota suficiente, se pausan las nuevas solicitudes de IA; se conservan los cambios y la edición manual y exportación siguen disponibles.' },
      ],
    },
  },
  {
    "version": "0.2.17",
    "date": "2026-10-26",
    "notes": {
      "en": [
        {
          "kind": "improved",
          "text": "Context compression keeps your original requests and local references to material analysis, tool results and images."
        },
        {
          "kind": "improved",
          "text": "Repeated compression reuses archived records without attaching the same original requests and image references twice."
        },
        {
          "kind": "fixed",
          "text": "Empty, truncated or cancelled summaries leave the original conversation intact, with at most one recovery attempt."
        }
      ],
      "zh-CN": [
        {
          "kind": "improved",
          "text": "压缩上下文时保留完整用户原话，并为素材分析、工具结果和图片提供本地回查记录。"
        },
        {
          "kind": "improved",
          "text": "连续压缩复用历史记录，避免重复附加同一份原话和图片引用。"
        },
        {
          "kind": "fixed",
          "text": "空摘要、截断或取消时保留原对话，失败恢复最多一次。"
        }
      ],
      "ja": [
        {
          "kind": "improved",
          "text": "コンテキスト圧縮時に元の依頼を保持し、素材分析、ツール結果、画像をローカル記録から参照できます。"
        },
        {
          "kind": "improved",
          "text": "繰り返し圧縮しても記録を再利用し、同じ依頼や画像参照を重複して追加しません。"
        },
        {
          "kind": "fixed",
          "text": "要約が空、途中終了、キャンセルの場合は元の会話を保持し、復旧は最大一回に制限します。"
        }
      ],
      "ko": [
        {
          "kind": "improved",
          "text": "컨텍스트 압축 시 원래 요청을 보존하고 소재 분석, 도구 결과와 이미지를 로컬 기록에서 다시 확인할 수 있습니다."
        },
        {
          "kind": "improved",
          "text": "반복 압축 시 보관된 기록을 재사용하여 같은 원문 요청과 이미지 참조가 중복으로 추가되지 않습니다."
        },
        {
          "kind": "fixed",
          "text": "비어 있거나 잘리거나 취소된 요약은 원래 대화를 유지하며 복구는 최대 한 번만 시도합니다."
        }
      ],
      "es": [
        {
          "kind": "improved",
          "text": "La compresión conserva tus solicitudes originales y referencias locales al análisis del material, los resultados de herramientas y las imágenes."
        },
        {
          "kind": "improved",
          "text": "Las compresiones sucesivas reutilizan los registros sin adjuntar dos veces las mismas solicitudes y referencias de imágenes."
        },
        {
          "kind": "fixed",
          "text": "Los resúmenes vacíos, truncados o cancelados conservan la conversación original, con un máximo de un intento de recuperación."
        }
      ]
    }
  },
  {
    "version": "0.2.16",
    "date": "2026-10-26",
    "notes": {
      "en": [
        {
          "kind": "improved",
          "text": "Repeated images in diagnostic logs share one stored copy and open on demand."
        },
        {
          "kind": "fixed",
          "text": "The bundled daocut command is now available in Git Bash on Windows."
        },
        {
          "kind": "improved",
          "text": "A lightweight timeline check catches invalid timing before visual review."
        }
      ],
      "zh-CN": [
        {
          "kind": "improved",
          "text": "诊断日志中的重复图片只保存一份，查看时按需打开。"
        },
        {
          "kind": "fixed",
          "text": "修复 Windows Git Bash 找不到内置 daocut 命令的问题。"
        },
        {
          "kind": "improved",
          "text": "新增轻量时间轴检查，先发现无效时间，再进行画面检查。"
        }
      ],
      "ja": [
        {
          "kind": "improved",
          "text": "診断ログの重複画像は一つだけ保存し、必要なときに開きます。"
        },
        {
          "kind": "fixed",
          "text": "Windows の Git Bash で内蔵 daocut コマンドを使えるようにしました。"
        },
        {
          "kind": "improved",
          "text": "軽量なタイムライン確認で、画面確認の前に無効な時間を検出します。"
        }
      ],
      "ko": [
        {
          "kind": "improved",
          "text": "진단 로그의 중복 이미지는 한 번만 저장하고 필요할 때 엽니다."
        },
        {
          "kind": "fixed",
          "text": "Windows Git Bash에서 내장 daocut 명령을 찾지 못하는 문제를 수정했습니다."
        },
        {
          "kind": "improved",
          "text": "가벼운 타임라인 검사로 화면 확인 전에 잘못된 시간을 감지합니다."
        }
      ],
      "es": [
        {
          "kind": "improved",
          "text": "Las imágenes repetidas de los registros comparten una copia y se abren cuando se necesitan."
        },
        {
          "kind": "fixed",
          "text": "El comando daocut integrado ya está disponible en Git Bash para Windows."
        },
        {
          "kind": "improved",
          "text": "Una comprobación ligera de la línea de tiempo detecta tiempos no válidos antes de revisar la imagen."
        }
      ]
    }
  },
  {
    version: '0.2.15', date: '2026-10-24',
    notes: {
      "en": [
        { kind: "improved", text: "Live commerce clips has a new cover. Its instructions no longer require a fixed delivery format or a default no-export rule." },
        { kind: "improved", text: "Empty conversations show three clip-editing suggestions at a time. Click one to place the request in the composer." },
        { kind: "improved", text: "Skill details keep the version number and no longer show the repository button." },
      ],
      "zh-CN": [
        { kind: "improved", text: "切片技能新增封面，删去固定交付格式和“默认不导出”的额外要求。" },
        { kind: "improved", text: "空白对话每次显示三条切片任务建议，点击即可填入输入框。" },
        { kind: "improved", text: "技能详情保留版本号，移除仓库跳转按钮。" },
      ],
      "ja": [
        { kind: "improved", text: "ライブコマース切り抜きに新しいカバーを追加しました。固定の納品形式と、標準で書き出さないという追加指示を削除しました。" },
        { kind: "improved", text: "空の会話には切り抜き編集の候補を一度に三つ表示します。クリックすると入力欄に依頼が入ります。" },
        { kind: "improved", text: "スキル詳細のバージョン番号を残し、リポジトリへのボタンを削除しました。" },
      ],
      "ko": [
        { kind: "improved", text: "라이브 커머스 클립에 새 표지를 추가했습니다. 고정 납품 형식과 기본적으로 내보내지 않는다는 추가 지침을 제거했습니다." },
        { kind: "improved", text: "빈 대화에는 클립 편집 제안을 한 번에 세 개씩 표시합니다. 클릭하면 요청이 입력창에 들어갑니다." },
        { kind: "improved", text: "스킬 상세의 버전 번호는 유지하고 저장소 이동 버튼을 제거했습니다." },
      ],
      "es": [
        { kind: "improved", text: "Clips de venta en directo tiene una nueva portada. Sus instrucciones ya no exigen un formato fijo de entrega ni una regla de no exportar por defecto." },
        { kind: "improved", text: "Las conversaciones vacías muestran tres sugerencias de edición de clips a la vez. Haz clic para colocar la solicitud en el cuadro de texto." },
        { kind: "improved", text: "Los detalles de la habilidad conservan la versión y ya no muestran el botón del repositorio." },
      ],
    },
  },
  {
    version: '0.2.14', date: '2026-10-24',
    notes: {
      "en": [
        { kind: "new", text: "Use /compact to summarize context while preserving goals, constraints and progress. Summary tokens are counted." },
        { kind: "new", text: "Diagnostics and feedback share one form with optional detailed records and screenshots. Feedback lists use less memory." },
        { kind: "fixed", text: "The log setting controls both entry points and closes open logs; token numbers remain visible." },
        { kind: "new", text: "Company admins can view tokens by employee, model and date, with offline delivery and recovery of registered turns after restart." },
        { kind: "improved", text: "The company sign-in page has been updated while preserving existing accounts and connection settings." },
        { kind: "fixed", text: "Feedback confirmations, stale diagnostics after sign-out, draft preservation and keyboard access are fixed, along with truncated final characters in long feedback." },
      ],
      "zh-CN": [
        { kind: "new", text: "使用 /compact 手动压缩上下文，保留目标、约束与进度，摘要用量计入 Token。" },
        { kind: "new", text: "诊断与问题反馈合并，可预览并选择详细记录和截图，反馈列表减少内存占用。" },
        { kind: "fixed", text: "日志开关统一控制两个入口，关闭时同步收起窗口，Token 数字继续显示。" },
        { kind: "new", text: "公司后台支持按员工、模型和日期查看 Token，断网补传并恢复重启前已登记回合的用量。" },
        { kind: "improved", text: "更新公司登录页面，保留原有账号和连接配置。" },
        { kind: "fixed", text: "修复反馈成功提示、退出后的旧诊断、草稿丢失与键盘访问，并修正长反馈的尾字符损坏。" },
      ],
      "ja": [
        { kind: "new", text: "/compact で目標、制約、進捗を保ちながらコンテキストを要約できます。要約のトークン使用量も記録します。" },
        { kind: "new", text: "診断とフィードバックを一つのフォームに統合しました。詳細記録と画像を選択でき、一覧のメモリ使用量も削減しました。" },
        { kind: "fixed", text: "ログ設定が両方の入口を制御し、無効にすると開いているログも閉じます。トークン数は引き続き表示します。" },
        { kind: "new", text: "会社の管理画面で従業員、モデル、日付別のトークン数を確認できます。オフライン送信と再起動前に登録したターンの使用量復元にも対応します。" },
        { kind: "improved", text: "既存のアカウントと接続設定を保ったまま、会社のログイン画面を更新しました。" },
        { kind: "fixed", text: "送信完了表示、ログアウト後の古い診断、下書きの保持、キーボード操作、長いフィードバックの末尾文字の欠損を修正しました。" },
      ],
      "ko": [
        { kind: "new", text: "/compact로 목표, 제약과 진행 상황을 유지하며 컨텍스트를 요약할 수 있습니다. 요약에 사용된 토큰도 집계합니다." },
        { kind: "new", text: "진단과 피드백을 한 양식으로 통합했습니다. 상세 기록과 스크린샷을 선택할 수 있고 목록의 메모리 사용량을 줄였습니다." },
        { kind: "fixed", text: "로그 설정이 두 진입점을 모두 제어하며 끄면 열린 로그도 닫힙니다. 토큰 숫자는 계속 표시됩니다." },
        { kind: "new", text: "회사 관리자는 직원, 모델, 날짜별 토큰을 확인할 수 있습니다. 오프라인 전송과 재시작 전 등록된 턴의 사용량 복구를 지원합니다." },
        { kind: "improved", text: "기존 계정과 연결 설정을 유지하면서 회사 로그인 화면을 업데이트했습니다." },
        { kind: "fixed", text: "피드백 성공 표시, 로그아웃 후 이전 진단 노출, 초안 보존, 키보드 접근 및 긴 피드백의 마지막 문자 손상을 수정했습니다." },
      ],
      "es": [
        { kind: "new", text: "Usa /compact para resumir el contexto conservando objetivos, restricciones y avances. Los tokens del resumen se contabilizan." },
        { kind: "new", text: "Diagnóstico y comentarios comparten un formulario con registros detallados e imágenes opcionales. La lista consume menos memoria." },
        { kind: "fixed", text: "El ajuste de registros controla ambos accesos y cierra las ventanas abiertas; los tokens siguen visibles." },
        { kind: "new", text: "La administración muestra tokens por empleado, modelo y fecha, con envío tras reconectar y recuperación de turnos registrados antes del reinicio." },
        { kind: "improved", text: "La página de acceso de empresa se ha actualizado conservando las cuentas y la configuración de conexión." },
        { kind: "fixed", text: "Se corrigen confirmaciones de envío, diagnósticos antiguos tras salir, pérdida de borradores, acceso con teclado y caracteres finales dañados en comentarios largos." },
      ],
    },
  },
  {
    version: '0.2.13', date: '2026-10-24',
    notes: {
      en: [
        { kind: 'new', text: 'Use /compact with your own API key to summarize the conversation while preserving goals, constraints and project progress. Project files remain unchanged.' },
        { kind: 'improved', text: 'Compaction uses the current model and counts its token usage; normal chat adds no extra approval calls.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '使用自有 API Key 时可输入 /compact 压缩上下文，摘要保留目标、约束和项目进度，不修改项目文件。' },
        { kind: 'improved', text: '压缩使用当前模型生成摘要并统计 Token，正常聊天不增加额外审批调用。' },
      ],
      ja: [
        { kind: 'new', text: '自分の API キーを使う場合、/compact で会話を要約できます。目標、制約、作業の進捗を引き継ぎ、プロジェクトのファイルは変更しません。' },
        { kind: 'improved', text: '要約には現在のモデルを使い、トークン使用量を記録します。通常のチャットに追加の承認呼び出しはありません。' },
      ],
      ko: [
        { kind: 'new', text: '자체 API 키 사용 시 /compact로 대화를 요약할 수 있습니다. 목표, 제약 조건과 프로젝트 진행 상황을 유지하며 프로젝트 파일은 변경하지 않습니다.' },
        { kind: 'improved', text: '요약에는 현재 모델을 사용하고 토큰 사용량을 집계합니다. 일반 채팅에는 추가 승인 호출이 없습니다.' },
      ],
      es: [
        { kind: 'new', text: 'Con tu propia clave API, usa /compact para resumir la conversación conservando objetivos, restricciones y avances. Los archivos del proyecto no cambian.' },
        { kind: 'improved', text: 'El resumen usa el modelo actual y registra sus tokens; el chat normal no añade llamadas de aprobación.' },
      ],
    },
  },

  {
    version: '0.2.12', date: '2026-10-24',
    notes: {
      en: [{ kind: 'fixed', text: 'Simple greeting-only messages cannot run tools when using your own API key. Editing requests continue normally without extra model review calls.' }],
      'zh-CN': [{ kind: 'fixed', text: '使用自有 API Key 时，单独发送“你好”等纯问候不会执行工具；明确的剪辑请求正常继续，不增加模型审核调用。' }],
      ja: [{ kind: 'fixed', text: '自分の API キーを使う場合、単純な挨拶だけではツールを実行しません。明確な編集依頼は追加のモデル審査なしで続行します。' }],
      ko: [{ kind: 'fixed', text: '자체 API 키 사용 시 단순한 인사만으로는 도구가 실행되지 않습니다. 명확한 편집 요청은 추가 모델 검토 없이 정상 진행됩니다.' }],
      es: [{ kind: 'fixed', text: 'Con tu propia clave API, los saludos simples no ejecutan herramientas. Las solicitudes de edición continúan sin llamadas adicionales de revisión al modelo.' }],
    },
  },
  {
    version: '0.2.11', date: '2026-10-24',
    notes: {
      en: [
        { kind: 'new', text: 'Open the context indicator to see usage and capacity, with locally estimated prompt, tool and conversation details when available.' },
        { kind: 'improved', text: 'Codex and supported Claude models use their native automatic permission review without requiring manual mode switching.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '上下文圆环可展开查看已用量和容量，支持时显示系统提示词、工具定义和对话消息的本地估算。' },
        { kind: 'improved', text: 'Codex 与支持的 Claude 模型优先使用原生自动审批，无需手动切换工作模式。' },
      ],
      ja: [
        { kind: 'new', text: 'コンテキスト表示を開くと使用量と上限を確認できます。対応時はプロンプト、ツール定義、会話のローカル推定値も表示します。' },
        { kind: 'improved', text: 'Codex と対応する Claude モデルで標準の自動権限審査を利用します。手動でモードを切り替える必要はありません。' },
      ],
      ko: [
        { kind: 'new', text: '컨텍스트 표시를 열어 사용량과 용량을 확인하세요. 지원되는 경우 프롬프트, 도구 정의, 대화의 로컬 추정치도 표시합니다.' },
        { kind: 'improved', text: 'Codex와 지원되는 Claude 모델은 기본 자동 권한 검토를 사용하므로 모드를 수동으로 전환할 필요가 없습니다.' },
      ],
      es: [
        { kind: 'new', text: 'Abre el indicador de contexto para consultar el uso y la capacidad, con estimaciones locales de instrucciones, herramientas y conversación cuando estén disponibles.' },
        { kind: 'improved', text: 'Codex y los modelos Claude compatibles usan su revisión automática de permisos sin cambiar de modo manualmente.' },
      ],
    },
  },
  {
    version: '0.2.10', date: '2026-10-24',
    notes: {
      en: [
        { kind: 'new', text: 'Install Live commerce clips from Discover to prepare an editable timeline; export it yourself when ready.' },
        { kind: 'fixed', text: 'Greetings no longer request a new film, and skipped questions no longer instruct the agent to invent a task.' },
        { kind: 'improved', text: 'Costs are shown only when fully estimable; token usage remains visible.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '发现页新增可安装的「切片」技能，默认剪好可编辑时间轴，由你自行点击导出。' },
        { kind: 'fixed', text: '修正普通问候触发制作的提示规则，跳过问题不再被当成新任务授权。' },
        { kind: 'improved', text: '费用可完整估算时才显示，无法计算时保留 Token 用量。' },
      ],
      ja: [
        { kind: 'new', text: '発見ページから「ライブコマース切り抜き」スキルをインストールできます。編集可能なタイムラインを作成し、書き出しは自分で行います。' },
        { kind: 'fixed', text: '挨拶を制作依頼と誤解しないよう指示を修正しました。質問のスキップは新しい作業の許可になりません。' },
        { kind: 'improved', text: '料金は全体を見積もれる場合のみ表示し、トークン使用量は引き続き表示します。' },
      ],
      ko: [
        { kind: 'new', text: '발견 페이지에서 라이브 커머스 클립 스킬을 설치할 수 있습니다. 편집 가능한 타임라인을 만들고 내보내기는 직접 진행합니다.' },
        { kind: 'fixed', text: '인사를 제작 요청으로 오해하지 않도록 지침을 수정했습니다. 질문을 건너뛰어도 새 작업을 허가한 것으로 간주하지 않습니다.' },
        { kind: 'improved', text: '비용을 완전히 추정할 수 있을 때만 표시하며 토큰 사용량은 계속 표시합니다.' },
      ],
      es: [
        { kind: 'new', text: 'Instala Clips de venta en directo desde Descubrir para preparar una línea de tiempo editable; expórtala cuando quieras.' },
        { kind: 'fixed', text: 'Se aclara que un saludo no solicita un vídeo y que omitir preguntas no autoriza tareas nuevas.' },
        { kind: 'improved', text: 'Los costes solo se muestran si pueden estimarse por completo; el uso de tokens sigue visible.' },
      ],
    },
  },
  {
    version: '0.2.9', date: '2026-10-24',
    notes: {
      en: [
        { kind: 'new', text: 'Chat shows current context usage separately from token totals and estimated model costs.' },
        { kind: 'new', text: 'Set optional model prices to estimate costs; unreported usage and unknown prices remain clearly marked.' },
        { kind: 'improved', text: 'A brief dark opening and transparent Daotian logo introduce the updated Daocut identity.' },
        { kind: 'improved', text: 'Discover now offers Video Replication and Advanced Motion Graphics. The examples gallery is removed.' },
        { kind: 'improved', text: 'Daocut commands and internal names are unified, with compatibility for existing settings and project history.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '对话显示当前上下文已用比例，与累计 Token 和模型费用分开显示。' },
        { kind: 'new', text: '模型可选填单价来估算费用，未报告用量或未知价格会明确标注。' },
        { kind: 'improved', text: '新增简约深色开场，稻田 Logo 去掉白底，统一 Daocut 品牌。' },
        { kind: 'improved', text: '发现页只保留视频复刻和高级 MG 动画，移除示例展示。' },
        { kind: 'improved', text: '统一 Daocut 工具和内部名称，兼容读取已有设置和项目历史。' },
      ],
      ja: [
        { kind: 'new', text: 'チャットに現在のコンテキスト使用率を表示します。累計トークン数とモデル料金の見積もりとは別に確認できます。' },
        { kind: 'new', text: 'モデル単価を任意で設定して料金を見積もれます。未報告の使用量や不明な単価は明示されます。' },
        { kind: 'improved', text: '短いダークカラーの起動演出と背景が透明なロゴで、Daocut の外観を統一しました。' },
        { kind: 'improved', text: '発見ページには動画再現と高度な MG アニメーションだけを表示し、サンプル展示を削除しました。' },
        { kind: 'improved', text: 'ツールと内部名称を Daocut に統一し、既存の設定とプロジェクト履歴を引き続き読み込めます。' },
      ],
      ko: [
        { kind: 'new', text: '채팅에서 현재 컨텍스트 사용률을 누적 토큰과 모델 예상 비용과 별도로 표시합니다.' },
        { kind: 'new', text: '모델 단가를 선택적으로 입력해 비용을 추정합니다. 보고되지 않은 사용량과 알 수 없는 가격은 명확히 표시됩니다.' },
        { kind: 'improved', text: '짧고 차분한 어두운 시작 화면과 투명한 로고로 Daocut 브랜드를 통일했습니다.' },
        { kind: 'improved', text: '발견 페이지에는 영상 재현과 고급 MG 애니메이션만 표시하며 예제 전시를 제거했습니다.' },
        { kind: 'improved', text: '도구와 내부 이름을 Daocut으로 통일하고 기존 설정과 프로젝트 기록을 계속 읽을 수 있도록 했습니다.' },
      ],
      es: [
        { kind: 'new', text: 'El chat muestra el uso actual del contexto por separado del total de tokens y el coste estimado del modelo.' },
        { kind: 'new', text: 'Puedes indicar precios del modelo para estimar costes; el uso no informado y los precios desconocidos se señalan claramente.' },
        { kind: 'improved', text: 'Una breve apertura oscura y el logotipo transparente de Daotian presentan la identidad de Daocut.' },
        { kind: 'improved', text: 'Descubrir ofrece solo Réplica de vídeo y Animación MG avanzada. Se elimina la galería de ejemplos.' },
        { kind: 'improved', text: 'Los comandos y nombres internos se unifican como Daocut, con lectura compatible de ajustes e historial existentes.' },
      ],
    },
  },
  {
    version: '0.2.8', date: '2026-10-24',
    notes: {
      en: [{ kind: 'fixed', text: 'Empty-frame capture failures can recover with bounded retries, and export errors retain the actual cause.' }, { kind: 'fixed', text: 'Long-conversation summaries use supported reasoning settings and a bounded recovery when the output limit is reached.' }],
      'zh-CN': [{ kind: 'fixed', text: '空截图失败可在有限次数内恢复，导出报错保留真正的异常原因。' }, { kind: 'fixed', text: '长对话摘要使用模型支持的推理设置，达到输出上限时在允许范围内尝试一次恢复。' }],
      ja: [{ kind: 'fixed', text: '空のフレーム取得を回数制限付きで再試行し、書き出しエラーに実際の原因を表示します。' }, { kind: 'fixed', text: '長い会話の要約に対応する推論設定を使い、出力上限に達した場合の復旧を制限付きで行います。' }],
      ko: [{ kind: 'fixed', text: '빈 프레임 캡처 실패를 제한된 횟수로 재시도하고 내보내기 오류에 실제 원인을 표시합니다.' }, { kind: 'fixed', text: '긴 대화 요약에 지원되는 추론 설정을 사용하며 출력 한도 도달 시 제한적으로 복구합니다.' }],
      es: [{ kind: 'fixed', text: 'La captura de fotogramas vacíos puede recuperarse con reintentos limitados; los errores de exportación conservan la causa real.' }, { kind: 'fixed', text: 'Los resúmenes de conversaciones largas usan ajustes de razonamiento compatibles y una recuperación limitada al alcanzar el límite de salida.' }],
    },
  },
  {
    version: '0.2.7',
    date: '2026-10-23',
    notes: {
      en: [
        { kind: 'fixed', text: 'Fixed employee sign-in failing with a valid company certificate in the desktop app while keeping certificate verification enabled.' },
      ],
      'zh-CN': [
        { kind: 'fixed', text: '修复桌面应用使用有效公司证书时员工账号无法登录的兼容问题，继续保留证书验证。' },
      ],
      ja: [
        { kind: 'fixed', text: 'デスクトップアプリで有効な会社証明書を使用しても社員アカウントでログインできない問題を修正しました。証明書の検証は引き続き有効です。' },
      ],
      ko: [
        { kind: 'fixed', text: '데스크톱 앱에서 유효한 회사 인증서를 사용해도 직원 계정으로 로그인할 수 없던 호환성 문제를 수정했습니다. 인증서 검증은 계속 유지됩니다.' },
      ],
      es: [
        { kind: 'fixed', text: 'Se corrigió el fallo de inicio de sesión de empleados con un certificado válido de la empresa en la aplicación de escritorio, manteniendo activa la verificación del certificado.' },
      ],
    },
  },
  {
    version: '0.2.6',
    date: '2026-10-23',
    notes: {
      en: [
        { kind: 'new', text: 'Company editions can import a connection profile and sign in with an employee account.' },
        { kind: 'new', text: 'Send feedback from Settings and follow your own reports, their status and administrator replies.' },
        { kind: 'improved', text: 'Model API keys are configured by each person on their computer; projects stay on that computer.' },
        { kind: 'new', text: 'Company deployments can configure an HTTPS update source on the local network and show update status in About.' },
        { kind: 'improved', text: 'A brief, simple opening animation respects the system setting for reduced motion.' },
        { kind: 'improved', text: 'Advanced settings group playback performance information, AI change history and troubleshooting logs under clearer names.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '公司版支持导入连接配置并登录员工账号。' },
        { kind: 'new', text: '可以在设置里提交问题反馈，查看自己的反馈、处理状态和管理员回复。' },
        { kind: 'improved', text: '模型 API Key 由每个人在本机配置，项目继续保存在本机。' },
        { kind: 'new', text: '公司部署可配置内网 HTTPS 更新源，并在“关于”中查看更新状态。' },
        { kind: 'improved', text: '新增简约、短暂的开场动画，遵循系统减少动态效果的设置。' },
        { kind: 'improved', text: '高级设置集中显示播放性能信息、AI 修改记录和故障排查日志，名称和说明更清楚。' },
      ],
      ja: [
        { kind: 'new', text: '会社向け版で接続設定を読み込み、社員アカウントでログインできます。' },
        { kind: 'new', text: '設定からフィードバックを送り、自分の報告、対応状況、管理者の返信を確認できます。' },
        { kind: 'improved', text: 'モデルの API キーは各自のパソコンで設定し、プロジェクトもそのパソコンに保存します。' },
        { kind: 'new', text: '会社での導入時に社内ネットワークの HTTPS 更新元を設定でき、「このアプリについて」で更新状況を確認できます。' },
        { kind: 'improved', text: '短くシンプルな起動アニメーションを追加しました。動きを減らすシステム設定に従います。' },
        { kind: 'improved', text: '詳細設定に再生パフォーマンス情報、AI の変更履歴、トラブル調査ログをまとめ、名称と説明をわかりやすくしました。' },
      ],
      ko: [
        { kind: 'new', text: '회사 버전에서 연결 설정을 가져오고 직원 계정으로 로그인할 수 있습니다.' },
        { kind: 'new', text: '설정에서 피드백을 보내고 내 보고 내용, 처리 상태와 관리자 답변을 확인할 수 있습니다.' },
        { kind: 'improved', text: '모델 API 키는 각자 컴퓨터에서 설정하며 프로젝트도 해당 컴퓨터에 저장됩니다.' },
        { kind: 'new', text: '회사 배포 시 사내 네트워크의 HTTPS 업데이트 소스를 설정하고 정보 화면에서 업데이트 상태를 확인할 수 있습니다.' },
        { kind: 'improved', text: '짧고 간결한 시작 애니메이션을 추가했습니다. 시스템의 동작 줄이기 설정을 따릅니다.' },
        { kind: 'improved', text: '고급 설정에 재생 성능 정보, AI 변경 기록과 문제 해결 로그를 모으고 이름과 설명을 명확히 했습니다.' },
      ],
      es: [
        { kind: 'new', text: 'La edición de empresa permite importar la configuración de conexión e iniciar sesión con una cuenta de empleado.' },
        { kind: 'new', text: 'Envía comentarios desde Ajustes y consulta tus propios informes, su estado y las respuestas del administrador.' },
        { kind: 'improved', text: 'Cada persona configura sus claves API de modelos en su equipo; los proyectos permanecen en ese equipo.' },
        { kind: 'new', text: 'Las instalaciones de empresa pueden configurar una fuente de actualizaciones HTTPS en la red local y mostrar su estado en Acerca de.' },
        { kind: 'improved', text: 'Una animación de inicio breve y sencilla respeta la preferencia del sistema de reducir el movimiento.' },
        { kind: 'improved', text: 'Los ajustes avanzados reúnen la información de rendimiento de reproducción, el historial de cambios de IA y los registros de diagnóstico con nombres más claros.' },
      ],
    },
  },
  {
    version: '0.2.5',
    date: '2026-10-21',
    notes: {
      en: [
        { kind: 'improved', text: 'Export › Editing project is two to four times faster and needs far less free disk space. You can choose how its pages are written; 剪映 and CapCut drafts show on the app’s home screen.' },
        { kind: 'improved', text: 'Exports keep the page’s colors in every format, and transparent HEVC and ProRes open as they should in Apple’s apps and in editors.' },
        { kind: 'improved', text: 'Exports are safer, on Windows above all: no broken file after a stop or a crash, nothing half-made left behind, and a full disk said plainly.' },
        { kind: 'new', text: 'DeepSeek Harness joins the agents the chat can use. Volume is in dB, up to +14 dB.' },
        { kind: 'improved', text: 'New project inside a folder makes it there, and renaming or moving a file keeps its subtitles.' },
        { kind: 'fixed', text: 'A mono voice exports as loud as it plays; bilingual burned-in subtitles show the translation once; ProRes footage plays and exports; the paused preview shows the exact frame.' },
      ],
      'zh-CN': [
        { kind: 'improved', text: '导出 › 剪辑工程快了 2 到 4 倍，需要的空闲磁盘空间也少得多。可以选择页面的写入方式；剪映和 CapCut 草稿会出现在它们的首页。' },
        { kind: 'improved', text: '各种格式的导出都保持页面原本的颜色；带透明的 HEVC 和 ProRes 在 Apple 的应用和剪辑软件里都能正确打开。' },
        { kind: 'improved', text: '导出更稳了，尤其在 Windows 上：停止或崩溃后不会留下损坏的文件，也不会残留半成品；磁盘满了会直接说明。' },
        { kind: 'new', text: '对话可以连接 DeepSeek Harness。音量改用 dB 显示，最高 +14 dB。' },
        { kind: 'improved', text: '在文件夹里新建项目会直接建在这个文件夹里；改名或移动文件时，字幕会跟着走。' },
        { kind: 'fixed', text: '单声道人声导出后和播放时一样响；双语字幕烧录时译文只显示一次；ProRes 素材能播放和导出；暂停时显示的就是精确的那一帧。' },
      ],
      ja: [
        { kind: 'improved', text: '書き出し › 編集プロジェクトが 2〜4 倍速くなり、必要な空き容量も大きく減りました。ページの書き出し方を選べ、剪映と CapCut の下書きはアプリのホームに表示されます。' },
        { kind: 'improved', text: 'どの形式でもページの色のまま書き出され、透過の HEVC と ProRes が Apple のアプリや編集ソフトで正しく開きます。' },
        { kind: 'improved', text: '書き出しがより安全になりました（特に Windows）。停止やクラッシュの後に壊れたファイルや作りかけのファイルが残らず、ディスクがいっぱいならそう伝えます。' },
        { kind: 'new', text: 'チャットで DeepSeek Harness を使えます。音量は dB 表示になり、最大 +14 dB です。' },
        { kind: 'improved', text: 'フォルダ内の新規プロジェクトはそのフォルダに作られ、ファイルの名前変更や移動で字幕も一緒に移ります。' },
        { kind: 'fixed', text: 'モノラルの声が再生時と同じ大きさで書き出され、二か国語の焼き込み字幕で訳が一度だけ表示され、ProRes の素材が再生・書き出しでき、一時停止中のプレビューが正確なフレームを表示します。' },
      ],
      ko: [
        { kind: 'improved', text: '내보내기 › 편집 프로젝트가 2~4배 빨라지고 필요한 여유 디스크 공간도 크게 줄었습니다. 페이지를 쓰는 방식을 고를 수 있고, 剪映와 CapCut 초안은 앱 홈 화면에 나타납니다.' },
        { kind: 'improved', text: '모든 형식에서 페이지 색 그대로 내보내고, 투명한 HEVC와 ProRes가 Apple 앱과 편집 프로그램에서 제대로 열립니다.' },
        { kind: 'improved', text: '내보내기가 더 안전해졌습니다(특히 Windows). 중지나 충돌 뒤에 깨진 파일이나 만들다 만 파일이 남지 않고, 디스크가 가득 차면 그렇게 알려 줍니다.' },
        { kind: 'new', text: '채팅에서 DeepSeek Harness를 쓸 수 있습니다. 음량은 dB로 표시되며 최대 +14 dB입니다.' },
        { kind: 'improved', text: '폴더 안에서 새 프로젝트를 만들면 그 폴더에 만들어지고, 파일 이름을 바꾸거나 옮겨도 자막이 함께 갑니다.' },
        { kind: 'fixed', text: '모노 음성이 재생할 때만큼 크게 내보내지고, 이중 언어 번인 자막의 번역이 한 번만 나오며, ProRes 소스가 재생·내보내기되고, 일시 정지한 미리 보기가 정확한 프레임을 보여 줍니다.' },
      ],
      es: [
        { kind: 'improved', text: 'Exportar › Proyecto de edición es de dos a cuatro veces más rápido y necesita mucho menos espacio libre. Puedes elegir cómo se escriben sus páginas; los borradores de 剪映 y CapCut aparecen en la pantalla de inicio de la app.' },
        { kind: 'improved', text: 'Las exportaciones mantienen los colores de la página en todos los formatos, y el HEVC y ProRes con transparencia se abren bien en las apps de Apple y en los editores.' },
        { kind: 'improved', text: 'Las exportaciones son más seguras, sobre todo en Windows: ningún archivo roto tras detenerla o un fallo, nada a medio hacer, y un disco lleno se dice con claridad.' },
        { kind: 'new', text: 'DeepSeek Harness se suma a los agentes del chat. El volumen va en dB, hasta +14 dB.' },
        { kind: 'improved', text: 'Nuevo proyecto dentro de una carpeta lo crea ahí, y al renombrar o mover un archivo sus subtítulos van con él.' },
        { kind: 'fixed', text: 'Una voz mono se exporta tan alta como suena; los subtítulos bilingües grabados muestran la traducción una vez; el material ProRes se reproduce y exporta; la vista previa en pausa muestra el fotograma exacto.' },
      ],
    },
  },
  {
    version: '0.2.4',
    date: '2026-10-20',
    notes: {
      en: [
        { kind: 'fixed', text: 'A new playback speed is heard the moment you pick it, and voices sound natural at any speed, even on long videos. The playback button shows a speed gauge, so it no longer looks like the inspector’s.' },
        { kind: 'fixed', text: 'The app’s own agent (your own key) keeps a long conversation going when it looks at many frames: older pictures are left out of each request, and a request a service finds too large is tried again with fewer.' },
      ],
      'zh-CN': [
        { kind: 'fixed', text: '换播放速度后立刻就有声音，任何速度下人声都自然，长视频也一样。播放按钮换成了速度表图标，不再和检查器的图标一样。' },
        { kind: 'fixed', text: '内置智能体（用你自己的 key）看了很多画面后，长对话也能继续：每次请求会省略较早的图片，服务嫌请求太大时会带更少的图自动重试。' },
      ],
      ja: [
        { kind: 'fixed', text: '再生速度を変えるとすぐに音が出て、どの速度でも声が自然に聞こえます。長い動画でも同じです。再生ボタンは速度計のアイコンになり、インスペクタのアイコンと区別できます。' },
        { kind: 'fixed', text: 'アプリ内蔵のエージェント（自分のキー）がたくさんのフレームを見ても、長い会話を続けられます。古い画像は各リクエストから省かれ、大きすぎると断られたリクエストは画像を減らして再試行します。' },
      ],
      ko: [
        { kind: 'fixed', text: '재생 속도를 바꾸면 바로 소리가 나고, 어떤 속도에서도 목소리가 자연스럽습니다. 긴 동영상도 마찬가지입니다. 재생 버튼은 속도계 아이콘이 되어 인스펙터 아이콘과 구별됩니다.' },
        { kind: 'fixed', text: '앱 자체 에이전트(내 키)가 많은 프레임을 봐도 긴 대화를 이어 갈 수 있습니다. 오래된 그림은 요청에서 빠지고, 너무 크다고 거절된 요청은 그림을 줄여 다시 시도합니다.' },
      ],
      es: [
        { kind: 'fixed', text: 'Una nueva velocidad de reproducción se oye en cuanto la eliges, y las voces suenan naturales a cualquier velocidad, también en vídeos largos. El botón de reproducción muestra un velocímetro y ya no se parece al del inspector.' },
        { kind: 'fixed', text: 'El agente propio de la app (tu propia clave) sigue una conversación larga aunque mire muchos fotogramas: las imágenes antiguas se omiten de cada solicitud, y una solicitud que el servicio rechaza por grande se reintenta con menos.' },
      ],
    },
  },
  {
    version: '0.2.3',
    date: '2026-10-20',
    notes: {
      en: [
        { kind: 'new', text: 'Skills: install Daocut’s from Discover, turn any skill on or off, and Try now starts a conversation with it. Choose a cover when you add your own.' },
        { kind: 'new', text: 'Keyboard shortcuts: use Daocut’s keys, Premiere Pro’s or Final Cut Pro’s, or record your own in Settings › Keyboard shortcuts.' },
        { kind: 'new', text: 'Page clips: make a layer’s words, picture or visibility a property and change it in the inspector; replace a picture right on it.' },
        { kind: 'improved', text: 'The viewer’s playback menu has loop, subtitles and speed from 0.25× to 2×, and sound keeps its pitch. Projects and tabs keep in step, and moving shows your folders as a tree.' },
        { kind: 'improved', text: 'Providers: four recommended first, the rest under More. Google transcribes speech for captions, and Microsoft Azure is set up service by service. Agents use your system’s proxy.' },
        { kind: 'fixed', text: 'On Windows, Codex from the Codex app starts, Install and Sign in open their window, and an editing-project export that can’t write to its drafts folder lands in your exports folder.' },
      ],
      'zh-CN': [
        { kind: 'new', text: 'Skill：在“发现”里安装 Daocut 的 skill，每个 skill 都能开关，“试一试”会用它开始一段对话。添加自己的 skill 时可以选封面。' },
        { kind: 'new', text: '快捷键：可以用 Daocut 的键位、Premiere Pro 或 Final Cut Pro 的键位，也可以在 设置 › 快捷键 里录自己的。' },
        { kind: 'new', text: '页面片段：把某一层的文字、图片或显示设为属性，在检查器里修改；图片可以直接在画面上替换。' },
        { kind: 'improved', text: '预览的播放菜单里有循环、字幕和 0.25× 到 2× 的速度，变速时声音保持原调。项目和标签页始终同步，移动时文件夹按层级显示。' },
        { kind: 'improved', text: '服务商：推荐的四家排在前面，其他的收在“更多”里。Google 可以转写语音做字幕，Microsoft Azure 按服务分别设置。智能体会使用系统代理。' },
        { kind: 'fixed', text: 'Windows 上：Codex 应用里的 Codex 能启动了，“安装”和“登录”会打开窗口，导出剪辑工程时草稿文件夹写不进去，草稿会放到导出文件夹。' },
      ],
      ja: [
        { kind: 'new', text: 'スキル：「見つける」から Daocut のスキルをインストールし、どのスキルもオン・オフでき、「試す」でそのスキルを使った会話を始められます。自分のスキルを追加するときはカバーを選べます。' },
        { kind: 'new', text: 'キーボードショートカット：Daocut、Premiere Pro、Final Cut Pro のキー配置から選ぶか、設定 › キーボードショートカットで自分のキーを登録できます。' },
        { kind: 'new', text: 'ページクリップ：レイヤーの文字、画像、表示をプロパティにしてインスペクタで変更できます。画像はその場で差し替えられます。' },
        { kind: 'improved', text: 'ビューアの再生メニューにループ、字幕、0.25×〜2× の速度があり、速度を変えても音の高さは変わりません。プロジェクトとタブは常に連動し、移動先のフォルダは階層で表示されます。' },
        { kind: 'improved', text: 'プロバイダ：おすすめの 4 社を先に、ほかは「その他」に。Google で音声を文字起こしして字幕にでき、Microsoft Azure はサービスごとに設定します。エージェントはシステムのプロキシを使います。' },
        { kind: 'fixed', text: 'Windows で、Codex アプリの Codex が起動し、「インストール」と「サインイン」がウィンドウを開き、編集プロジェクトの書き出しで下書きフォルダに書けないときは書き出しフォルダに保存されます。' },
      ],
      ko: [
        { kind: 'new', text: '스킬: 찾아보기에서 Daocut 스킬을 설치하고, 모든 스킬을 켜고 끌 수 있으며, 사용해 보기로 그 스킬과 대화를 시작합니다. 내 스킬을 추가할 때 표지를 고를 수 있습니다.' },
        { kind: 'new', text: '키보드 단축키: Daocut, Premiere Pro, Final Cut Pro의 키 배치 중에서 고르거나, 설정 › 키보드 단축키에서 직접 키를 지정할 수 있습니다.' },
        { kind: 'new', text: '페이지 클립: 레이어의 글자, 그림, 표시 여부를 속성으로 만들어 인스펙터에서 바꿀 수 있고, 그림은 화면에서 바로 교체할 수 있습니다.' },
        { kind: 'improved', text: '뷰어의 재생 메뉴에 반복, 자막, 0.25×~2× 속도가 있고, 속도를 바꿔도 음높이는 그대로입니다. 프로젝트와 탭이 항상 함께 맞춰지고, 옮길 때 폴더가 계층으로 보입니다.' },
        { kind: 'improved', text: '서비스 제공자: 추천 4곳을 먼저, 나머지는 더 보기에. Google로 음성을 받아써 자막을 만들고, Microsoft Azure는 서비스별로 설정합니다. 에이전트는 시스템 프록시를 사용합니다.' },
        { kind: 'fixed', text: 'Windows에서 Codex 앱의 Codex가 시작되고, 설치와 로그인이 창을 열며, 편집 프로젝트 내보내기에서 초안 폴더에 쓸 수 없으면 내보내기 폴더에 저장됩니다.' },
      ],
      es: [
        { kind: 'new', text: 'Skills: instala las de Daocut desde Descubrir, activa o desactiva cualquiera, y Probar empieza una conversación con ella. Elige una portada al añadir las tuyas.' },
        { kind: 'new', text: 'Atajos de teclado: usa las teclas de Daocut, de Premiere Pro o de Final Cut Pro, o graba las tuyas en Ajustes › Atajos de teclado.' },
        { kind: 'new', text: 'Clips de página: convierte el texto, la imagen o la visibilidad de una capa en una propiedad y cámbiala en el inspector; reemplaza una imagen directamente sobre ella.' },
        { kind: 'improved', text: 'El menú de reproducción del visor tiene bucle, subtítulos y velocidad de 0,25× a 2×, y el sonido mantiene su tono. Los proyectos y las pestañas van siempre a la par, y al mover ves tus carpetas como un árbol.' },
        { kind: 'improved', text: 'Proveedores: los cuatro recomendados primero y el resto en Más. Google transcribe la voz para subtítulos y Microsoft Azure se configura servicio por servicio. Los agentes usan el proxy del sistema.' },
        { kind: 'fixed', text: 'En Windows, Codex de la app de Codex arranca, Instalar e Iniciar sesión abren su ventana, y una exportación de proyecto de edición que no puede escribir en su carpeta de borradores queda en tu carpeta de exportaciones.' },
      ],
    },
  },
  {
    version: '0.2.2',
    date: '2026-10-19',
    notes: {
      en: [
        { kind: 'new', text: 'An export can be named where you choose its folder.' },
        { kind: 'new', text: 'Agents work when you installed only the maker’s app: Claude Code and OpenCode are found inside their apps, and Settings › Agents installs the others with their official installer.' },
        { kind: 'improved', text: 'When the app’s own agent tries its model service again, the chat says so. Final Cut Pro subtitles keep their look and size.' },
        { kind: 'fixed', text: 'On Windows, agents start again: 0.2.1 handed them the path of cmd.exe unexpanded. Connecting Cursor no longer opens the Cursor editor.' },
        { kind: 'fixed', text: 'On a Mac, an update installs when you quit, even if you open Daocut again right away.' },
        { kind: 'fixed', text: 'daocut render takes frame rates like 29.97; 4K and transparent WebM footage get their contact sheets; a render that fails on Windows says why.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '导出时可以在选文件夹的地方给文件起名。' },
        { kind: 'new', text: '只装了官方应用也能用智能体：Claude Code 和 OpenCode 能在它们的应用里找到，其他的在 设置 › 智能体 里用官方安装程序一键安装。' },
        { kind: 'improved', text: '内置智能体重新请求模型服务时，对话里会提示。Final Cut Pro 字幕保持原来的样式和大小。' },
        { kind: 'fixed', text: 'Windows 上智能体又能启动了：0.2.1 交给它们的 cmd.exe 路径没有展开。连接 Cursor 不会再打开 Cursor 编辑器。' },
        { kind: 'fixed', text: 'Mac 上退出时会安装更新，即使你马上又打开 Daocut。' },
        { kind: 'fixed', text: 'daocut render 支持 29.97 这样的帧率；4K 和透明 WebM 视频也能生成缩略图；Windows 上渲染失败会说明原因。' },
      ],
      ja: [
        { kind: 'new', text: '書き出しのファイル名を、フォルダを選ぶ場所で付けられます。' },
        { kind: 'new', text: '公式アプリだけを入れていてもエージェントが使えます。Claude Code と OpenCode はそれぞれのアプリの中から見つけ、ほかは設定 › エージェントから公式インストーラーで入れられます。' },
        { kind: 'improved', text: 'アプリ内蔵のエージェントがモデルサービスに再試行するとき、チャットに表示します。Final Cut Pro の字幕は見た目とサイズを保ちます。' },
        { kind: 'fixed', text: 'Windows でエージェントが再び起動します。0.2.1 では cmd.exe のパスを展開せずに渡していました。Cursor に接続しても Cursor エディタは開きません。' },
        { kind: 'fixed', text: 'Mac では終了時にアップデートがインストールされます。すぐに Daocut を開き直しても同じです。' },
        { kind: 'fixed', text: 'daocut render が 29.97 のようなフレームレートに対応。4K や透過 WebM の映像もコンタクトシートを作れます。Windows で失敗した書き出しは理由を表示します。' },
      ],
      ko: [
        { kind: 'new', text: '내보낼 때 폴더를 고르는 곳에서 파일 이름을 정할 수 있습니다.' },
        { kind: 'new', text: '공식 앱만 설치해도 에이전트를 쓸 수 있습니다. Claude Code와 OpenCode는 각 앱 안에서 찾고, 나머지는 설정 › 에이전트에서 공식 설치 프로그램으로 설치합니다.' },
        { kind: 'improved', text: '앱 자체 에이전트가 모델 서비스를 다시 시도하면 채팅에 알려 줍니다. Final Cut Pro 자막은 모양과 크기를 유지합니다.' },
        { kind: 'fixed', text: 'Windows에서 에이전트가 다시 시작됩니다. 0.2.1은 cmd.exe 경로를 펼치지 않고 넘겼습니다. Cursor를 연결해도 Cursor 편집기가 열리지 않습니다.' },
        { kind: 'fixed', text: 'Mac에서는 종료할 때 업데이트가 설치됩니다. 바로 Daocut을 다시 열어도 마찬가지입니다.' },
        { kind: 'fixed', text: 'daocut render가 29.97 같은 프레임 레이트를 받습니다. 4K와 투명 WebM 영상도 콘택트 시트가 만들어지고, Windows에서 실패한 렌더는 이유를 알려 줍니다.' },
      ],
      es: [
        { kind: 'new', text: 'Una exportación se puede nombrar donde eliges su carpeta.' },
        { kind: 'new', text: 'Los agentes funcionan aunque solo tengas la app de su fabricante: Claude Code y OpenCode se encuentran dentro de sus apps, y Ajustes › Agentes instala los demás con su instalador oficial.' },
        { kind: 'improved', text: 'Cuando el agente propio de la app reintenta su servicio de modelos, el chat lo dice. Los subtítulos de Final Cut Pro mantienen su aspecto y tamaño.' },
        { kind: 'fixed', text: 'En Windows los agentes vuelven a arrancar: 0.2.1 les daba la ruta de cmd.exe sin expandir. Conectar Cursor ya no abre el editor Cursor.' },
        { kind: 'fixed', text: 'En un Mac, una actualización se instala al salir, aunque vuelvas a abrir Daocut enseguida.' },
        { kind: 'fixed', text: 'daocut render acepta frecuencias como 29.97; el material 4K y los WebM transparentes tienen su hoja de contactos; un render que falla en Windows dice por qué.' },
      ],
    },
  },
  {
    version: '0.2.1',
    date: '2026-10-19',
    notes: {
      en: [
        { kind: 'new', text: 'The timeline has a main track with its magnet and linkage, and a preview axis. Moving, pasting or dropping a clip never cuts another one.' },
        { kind: 'new', text: 'Projects lists every project in your projects folder, and a project can have its own cover. Export › Editing project adds Final Cut Pro.' },
        { kind: 'improved', text: 'Preview, scrubbing and the timeline stay smooth even in big films, and exports leave the computer usable.' },
        { kind: 'improved', text: 'The chat takes any number of files and folders, where they are. Settings › Developer has Diagnostics, and each of your own models takes its context length.' },
        { kind: 'improved', text: 'The app’s own agent waits up to 15 minutes for a model that thinks before it answers, and a failed turn says why.' },
        { kind: 'fixed', text: 'Footage the browser can’t decode plays everywhere; file names with #, ? and % work; Gemini CLI, which Google no longer serves, leaves the agents.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '时间线新增主轨，带主轨磁吸和联动，还有预览轴。移动、粘贴或拖入片段，都不会把别的片段切开。' },
        { kind: 'new', text: '项目页会列出项目文件夹里的所有项目，每个项目也可以设置自己的封面。导出 › 剪辑工程 新增 Final Cut Pro。' },
        { kind: 'improved', text: '预览、拖动播放头和时间线在大项目里也很流畅；导出时电脑仍然好用。' },
        { kind: 'improved', text: '对话可以添加任意多个文件和文件夹，不会复制，原样引用。设置 › 开发者 新增「诊断」；自有密钥的每个模型可以填自己的上下文长度。' },
        { kind: 'improved', text: '内置智能体等模型思考的时间延长到 15 分钟；一轮失败时会说明原因。' },
        { kind: 'fixed', text: '浏览器无法解码的视频也能在各处播放；文件名里有 #、? 和 % 也没问题；Google 已停止服务的 Gemini CLI 不再出现在智能体里。' },
      ],
      ja: [
        { kind: 'new', text: 'タイムラインにメイントラックが加わり、メイントラックのマグネットと連動、プレビュー軸も使えます。クリップを移動・貼り付け・ドロップしても、ほかのクリップが切られることはありません。' },
        { kind: 'new', text: 'プロジェクト画面にプロジェクトフォルダ内のすべてのプロジェクトが並び、プロジェクトごとにカバーを設定できます。書き出し › 編集プロジェクトに Final Cut Pro が加わりました。' },
        { kind: 'improved', text: '大きな映像でもプレビュー、スクラブ、タイムラインが滑らかで、書き出し中もパソコンを普通に使えます。' },
        { kind: 'improved', text: 'チャットにファイルやフォルダをいくつでも、コピーせずにそのまま添付できます。設定 › 開発者に「診断」が加わり、自分のキーの各モデルにコンテキスト長を設定できます。' },
        { kind: 'improved', text: 'アプリ内蔵のエージェントは、考えてから答えるモデルを最大 15 分待ちます。失敗したターンは理由を表示します。' },
        { kind: 'fixed', text: 'ブラウザで再生できない動画もどこでも再生できます。#、?、% を含むファイル名も使えます。Google が提供を終えた Gemini CLI はエージェントから外れました。' },
      ],
      ko: [
        { kind: 'new', text: '타임라인에 메인 트랙이 생기고 메인 트랙 자석과 연동, 미리보기 축을 쓸 수 있습니다. 클립을 옮기거나 붙여 넣거나 끌어 놓아도 다른 클립이 잘리지 않습니다.' },
        { kind: 'new', text: '프로젝트 화면에 프로젝트 폴더의 모든 프로젝트가 보이고, 프로젝트마다 표지를 정할 수 있습니다. 내보내기 › 편집 프로젝트에 Final Cut Pro가 추가되었습니다.' },
        { kind: 'improved', text: '큰 영상에서도 미리보기, 스크러빙, 타임라인이 부드럽고, 내보내는 동안에도 컴퓨터를 편하게 쓸 수 있습니다.' },
        { kind: 'improved', text: '채팅에 파일과 폴더를 개수 제한 없이, 복사하지 않고 그대로 첨부할 수 있습니다. 설정 › 개발자에 "진단"이 생겼고, 내 키의 모델마다 컨텍스트 길이를 정할 수 있습니다.' },
        { kind: 'improved', text: '앱 자체 에이전트는 생각한 뒤 답하는 모델을 최대 15분 기다리고, 실패한 턴은 이유를 알려 줍니다.' },
        { kind: 'fixed', text: '브라우저가 디코딩하지 못하는 영상도 어디서나 재생됩니다. #, ?, %가 들어간 파일 이름도 됩니다. Google이 서비스를 끝낸 Gemini CLI는 에이전트에서 빠졌습니다.' },
      ],
      es: [
        { kind: 'new', text: 'La línea de tiempo tiene una pista principal con su imán y la vinculación, y un eje de vista previa. Mover, pegar o soltar un clip nunca corta otro.' },
        { kind: 'new', text: 'Proyectos muestra todos los proyectos de tu carpeta de proyectos, y cada proyecto puede tener su propia portada. Exportar › Proyecto de edición añade Final Cut Pro.' },
        { kind: 'improved', text: 'La vista previa, el desplazamiento y la línea de tiempo van fluidos incluso en películas grandes, y exportar deja el equipo usable.' },
        { kind: 'improved', text: 'El chat admite cualquier número de archivos y carpetas, donde están, sin copiarlos. Ajustes › Desarrollador tiene Diagnóstico, y cada modelo de tu propia clave admite su longitud de contexto.' },
        { kind: 'improved', text: 'El agente propio de la app espera hasta 15 minutos a un modelo que piensa antes de responder, y un turno fallido dice por qué.' },
        { kind: 'fixed', text: 'El vídeo que el navegador no puede decodificar se reproduce en todas partes; los nombres de archivo con #, ? y % funcionan; Gemini CLI, que Google ya no ofrece, deja los agentes.' },
      ],
    },
  },
  {
    version: '0.2.0',
    date: '2026-10-17',
    notes: {
      en: [
        { kind: 'new', text: 'Tabs: each open project in a tab of its own. The projects window has Examples to start a new film from.' },
        { kind: 'new', text: 'Skills: type / in the chat to make a film with one, or open Community for the official skills and the examples. Ten official skills, including replicate: give it a video and it makes yours like it.' },
        { kind: 'new', text: 'Saved: your own library of files and clips, the same in every project. Right-click a clip and choose Add to Saved.' },
        { kind: 'new', text: 'Your own key takes several models, each with its own service and key. Settings › Services sets who makes each kind of media, and Settings › General › Storage where new projects go.' },
        { kind: 'improved', text: 'The examples and skills show at once, even on a slow connection, and a project with thousands of files plays smoothly as soon as it opens.' },
        { kind: 'fixed', text: 'Your own key works again; a film with hundreds of sounds exports on Windows; when Codex can’t start, the chat says why.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '标签页：每个打开的项目一个标签页。项目窗口新增「示例」，可以从示例开始做新片。' },
        { kind: 'new', text: 'Skill：在对话里输入 / 选一个 Skill 来做片，或打开「社区」查看官方 Skill 和示例。新增十个官方 Skill，包括 replicate：给它一个视频，按它的样子做你的片。' },
        { kind: 'new', text: '收藏：你自己的素材库，每个项目里都一样。在片段上右键选择「收藏」。' },
        { kind: 'new', text: '自有密钥可以添加多个模型，每个用自己的服务和密钥。设置 › 服务 选择每类媒体由谁生成，设置 › 通用 › 存储位置 选择新项目放在哪里。' },
        { kind: 'improved', text: '示例和 Skill 打开即显示，网络慢也不用等；文件上千的项目一打开就能流畅播放。' },
        { kind: 'fixed', text: '自有密钥恢复可用；Windows 上声音很多的影片可以正常导出；Codex 无法启动时，对话里会说明原因。' },
      ],
      ja: [
        { kind: 'new', text: 'タブ：開いているプロジェクトはそれぞれ専用のタブに。プロジェクトウィンドウに「サンプル」が加わり、そこから新しい映像を始められます。' },
        { kind: 'new', text: 'スキル：チャットで / を入力してスキルで映像を作るか、「コミュニティ」で公式スキルとサンプルを見られます。公式スキルは 10 種類、replicate もあります：動画を渡すと、それに似せてあなたの映像を作ります。' },
        { kind: 'new', text: 'コレクション：どのプロジェクトでも同じ、自分専用のファイルとクリップの置き場所。クリップを右クリックして「コレクションに追加」を選びます。' },
        { kind: 'new', text: '自分のキーで複数のモデルを、それぞれ専用のサービスとキーで使えます。設定 › サービスで各メディアの生成先を、設定 › 一般 › 保存場所で新しいプロジェクトの場所を選べます。' },
        { kind: 'improved', text: 'サンプルとスキルは回線が遅くてもすぐに表示され、ファイルが数千あるプロジェクトも開いてすぐ滑らかに再生できます。' },
        { kind: 'fixed', text: '自分のキーが再び使えるようになりました。Windows で音の多い映像を書き出せます。Codex が起動できないとき、チャットに理由が表示されます。' },
      ],
      ko: [
        { kind: 'new', text: '탭: 열린 프로젝트마다 탭 하나. 프로젝트 창에 "예시"가 생겨 예시에서 새 영상을 시작할 수 있습니다.' },
        { kind: 'new', text: '스킬: 채팅에서 /를 입력해 스킬로 영상을 만들거나, "커뮤니티"에서 공식 스킬과 예시를 볼 수 있습니다. 공식 스킬 10개, replicate 포함: 영상을 주면 그와 닮은 내 영상을 만듭니다.' },
        { kind: 'new', text: '보관함: 모든 프로젝트에서 같은 나만의 파일과 클립 보관 장소. 클립을 마우스 오른쪽 버튼으로 클릭하고 "보관함에 추가"를 고르세요.' },
        { kind: 'new', text: '내 키로 여러 모델을 각자의 서비스와 키로 쓸 수 있습니다. 설정 › 서비스에서 미디어별 생성 서비스를, 설정 › 일반 › 저장 위치에서 새 프로젝트 위치를 고릅니다.' },
        { kind: 'improved', text: '예시와 스킬은 연결이 느려도 바로 보이고, 파일이 수천 개인 프로젝트도 열자마자 부드럽게 재생됩니다.' },
        { kind: 'fixed', text: '내 키가 다시 작동합니다. Windows에서 소리가 많은 영상도 내보낼 수 있습니다. Codex가 시작되지 않으면 채팅에서 이유를 알려 줍니다.' },
      ],
      es: [
        { kind: 'new', text: 'Pestañas: cada proyecto abierto en su propia pestaña. La ventana de proyectos tiene Ejemplos para empezar una película nueva desde uno.' },
        { kind: 'new', text: 'Skills: escribe / en el chat para hacer una película con una, o abre Comunidad para ver las skills oficiales y los ejemplos. Diez skills oficiales, entre ellas replicate: dale un video y hace la tuya como él.' },
        { kind: 'new', text: 'Guardados: tu propia biblioteca de archivos y clips, la misma en todos los proyectos. Haz clic derecho en un clip y elige Añadir a Guardados.' },
        { kind: 'new', text: 'Tu propia clave admite varios modelos, cada uno con su servicio y su clave. Ajustes › Servicios elige quién hace cada tipo de medio, y Ajustes › General › Almacenamiento dónde van los proyectos nuevos.' },
        { kind: 'improved', text: 'Los ejemplos y las skills aparecen al instante, incluso con una conexión lenta, y un proyecto con miles de archivos se reproduce con fluidez nada más abrirlo.' },
        { kind: 'fixed', text: 'Tu propia clave vuelve a funcionar; una película con cientos de sonidos se exporta en Windows; cuando Codex no puede iniciarse, el chat dice por qué.' },
      ],
    },
  },
  {
    version: '0.1.7',
    date: '2026-10-14',
    notes: {
      en: [
        { kind: 'new', text: 'Settings › Providers takes services of your own (your voice, a transcription server on this computer, an API that isn’t listed), and your agent can use them.' },
        { kind: 'new', text: 'A title can be restyled together with every title like it (“All like it”), and several layers picked together scale and turn by their box.' },
        { kind: 'new', text: 'Your own key: each model gets the reasoning efforts it takes, and the chat’s model menu offers them.' },
        { kind: 'improved', text: 'Markers have a row of their own under the ruler, and the timeline shows the main track by its look.' },
        { kind: 'improved', text: 'Claude Code runs on your Claude subscription and signs in its own way; its model menu shows its four current models.' },
        { kind: 'fixed', text: 'On Windows, command windows no longer flash up while the app checks or talks to your agents.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '设置 › 服务商 可以添加你自己的服务（自己的声音、本机的转写服务、未列出的 API），智能体可以直接使用。' },
        { kind: 'new', text: '标题可以和同类标题一起改样式（「所有同类」）；多选的图层可以按整体框一起缩放、旋转。' },
        { kind: 'new', text: '自有密钥：每个模型可以设置它支持的推理档位，对话里的模型菜单会提供这些档位。' },
        { kind: 'improved', text: '标记在标尺下方有了单独的一行；时间线用外观区分主轨道。' },
        { kind: 'improved', text: 'Claude Code 只使用你的 Claude 订阅，并按官方方式授权登录；模型菜单显示它当前的四个模型。' },
        { kind: 'fixed', text: 'Windows 上检查或使用智能体时，不再不停弹出命令行窗口。' },
      ],
      ja: [
        { kind: 'new', text: '設定 › プロバイダーに自分のサービス（自分の声、このコンピューターの文字起こしサーバー、一覧にない API）を追加でき、エージェントが使えます。' },
        { kind: 'new', text: 'タイトルを同じ種類のタイトルとまとめてスタイル変更でき（「同じ種類すべて」）、複数選んだレイヤーは枠ごと拡大縮小・回転できます。' },
        { kind: 'new', text: '自分のキー：モデルごとに対応する推論の強さを設定でき、チャットのモデルメニューで選べます。' },
        { kind: 'improved', text: 'マーカーはルーラーの下に専用の行ができ、タイムラインはメイントラックを見た目で示します。' },
        { kind: 'improved', text: 'Claude Code は Claude のサブスクリプションだけで動き、公式の方法でサインインします。モデルメニューには現在の 4 つのモデルが表示されます。' },
        { kind: 'fixed', text: 'Windows で、エージェントの確認や利用のたびにコマンドウィンドウが開かなくなりました。' },
      ],
      ko: [
        { kind: 'new', text: '설정 › 제공업체에 내 서비스(내 목소리, 이 컴퓨터의 전사 서버, 목록에 없는 API)를 추가할 수 있고, 에이전트가 사용할 수 있습니다.' },
        { kind: 'new', text: '제목을 같은 종류의 제목과 함께 스타일 변경할 수 있고("같은 종류 모두"), 여러 레이어를 선택하면 상자째로 크기를 바꾸고 회전할 수 있습니다.' },
        { kind: 'new', text: '내 키: 모델마다 지원하는 추론 강도를 정할 수 있고, 채팅의 모델 메뉴에서 고를 수 있습니다.' },
        { kind: 'improved', text: '마커는 눈금자 아래 전용 줄에 놓이고, 타임라인은 메인 트랙을 모양으로 보여 줍니다.' },
        { kind: 'improved', text: 'Claude Code는 Claude 구독으로만 실행되고 공식 방식으로 로그인합니다. 모델 메뉴에는 현재의 네 모델이 나옵니다.' },
        { kind: 'fixed', text: 'Windows에서 에이전트를 확인하거나 사용할 때 명령 창이 더 이상 뜨지 않습니다.' },
      ],
      es: [
        { kind: 'new', text: 'Ajustes › Proveedores admite servicios tuyos (tu voz, un servidor de transcripción en este equipo, una API que no está en la lista), y tu agente puede usarlos.' },
        { kind: 'new', text: 'Un título puede cambiar de estilo junto con todos los títulos como él («Todos los iguales»), y varias capas seleccionadas se escalan y giran con su caja.' },
        { kind: 'new', text: 'Tu propia clave: cada modelo tiene los esfuerzos de razonamiento que admite, y el menú de modelos del chat los ofrece.' },
        { kind: 'improved', text: 'Los marcadores tienen su propia fila bajo la regla, y la línea de tiempo muestra la pista principal por su aspecto.' },
        { kind: 'improved', text: 'Claude Code funciona solo con tu suscripción de Claude e inicia sesión a su manera; su menú de modelos muestra sus cuatro modelos actuales.' },
        { kind: 'fixed', text: 'En Windows ya no se abren ventanas de comandos mientras la app revisa o usa tus agentes.' },
      ],
    },
  },
  {
    version: '0.1.6',
    date: '2026-10-13',
    notes: {
      en: [
        { kind: 'new', text: 'Export › Editing project makes a CapCut draft: your timeline opens on its home screen, ready to keep cutting. Premiere Pro and DaVinci Resolve get the XML.' },
        { kind: 'new', text: 'Settings › Agents shows whose account Claude Code and Codex use, and what is left of the Codex plan, without opening them.' },
        { kind: 'improved', text: 'Settings › About checks for updates by itself, shows the download, and restarts to update.' },
        { kind: 'fixed', text: 'A 16:9 export is exactly 1920 × 1080 (or 3840 × 2160), whatever the film’s own shape.' },
        { kind: 'fixed', text: 'Choosing where exports go opens the folder dialog in front, and it stays open.' },
      ],
      'zh-CN': [
        { kind: 'new', text: '导出 › 剪辑工程可以生成剪映草稿：时间线直接出现在剪映首页，接着剪；Premiere Pro 和 DaVinci Resolve 仍用 XML。' },
        { kind: 'new', text: '设置 › 智能体 直接显示 Claude Code 和 Codex 当前用的账号，以及 Codex 的剩余额度，不用再打开它们查看。' },
        { kind: 'new', text: '中文界面的社交平台导出新增哔哩哔哩、抖音、快手、视频号和小红书。' },
        { kind: 'improved', text: '设置 › 关于 会自动检查更新，显示下载进度，下载好后点一下即可重启更新。' },
        { kind: 'fixed', text: '16:9 导出准确为 1920 × 1080（4K 为 3840 × 2160），不再受影片自身画幅影响。' },
        { kind: 'fixed', text: '选择导出位置时，文件夹窗口会出现在最前面，不再一闪而过。' },
      ],
      ja: [
        { kind: 'new', text: '書き出し › 編集プロジェクトで CapCut の下書きを作れます。タイムラインがホーム画面に表示され、そのまま編集を続けられます。Premiere Pro と DaVinci Resolve には XML を書き出します。' },
        { kind: 'new', text: '設定 › エージェントで、Claude Code と Codex が使っているアカウントと、Codex の残りの利用枠を、それぞれを開かずに確認できます。' },
        { kind: 'improved', text: '設定 › 情報 でアップデートを自動で確認し、ダウンロードの進み具合を表示します。準備ができたら再起動で更新できます。' },
        { kind: 'fixed', text: '16:9 の書き出しは、映像自体の比率にかかわらず正確に 1920 × 1080（または 3840 × 2160）になります。' },
        { kind: 'fixed', text: '書き出し先を選ぶフォルダーのダイアログが手前に開き、すぐに閉じなくなりました。' },
      ],
      ko: [
        { kind: 'new', text: '내보내기 › 편집 프로젝트에서 CapCut 초안을 만들 수 있습니다. 타임라인이 홈 화면에 바로 나타나 이어서 편집할 수 있습니다. Premiere Pro와 DaVinci Resolve는 XML로 내보냅니다.' },
        { kind: 'new', text: '설정 › 에이전트에서 Claude Code와 Codex가 사용하는 계정과 Codex의 남은 사용량을 각각 열지 않고 볼 수 있습니다.' },
        { kind: 'improved', text: '설정 › 정보에서 업데이트를 자동으로 확인하고 다운로드 진행 상황을 보여 줍니다. 준비되면 다시 시작해 업데이트하세요.' },
        { kind: 'fixed', text: '16:9 내보내기는 영상 자체의 비율과 관계없이 정확히 1920 × 1080(또는 3840 × 2160)입니다.' },
        { kind: 'fixed', text: '내보낼 위치를 고르는 폴더 대화상자가 앞에 열리고, 바로 닫히지 않습니다.' },
      ],
      es: [
        { kind: 'new', text: 'Exportar › Proyecto de edición crea un borrador de CapCut: tu línea de tiempo aparece en su pantalla de inicio, lista para seguir editando. Premiere Pro y DaVinci Resolve reciben el XML.' },
        { kind: 'new', text: 'Ajustes › Agentes muestra qué cuenta usan Claude Code y Codex, y cuánto le queda al plan de Codex, sin abrirlos.' },
        { kind: 'improved', text: 'Ajustes › Acerca de busca actualizaciones por sí solo, muestra la descarga y se reinicia para actualizar.' },
        { kind: 'fixed', text: 'Una exportación 16:9 mide exactamente 1920 × 1080 (o 3840 × 2160), sea cual sea la forma de la película.' },
        { kind: 'fixed', text: 'Al elegir dónde exportar, el diálogo de carpetas se abre delante y no se cierra solo.' },
      ],
    },
  },
];

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (x.y.z; a pre-release is older than its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.split('-');
    return { parts: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The releases to tell of after an update from `seen` to `current`: those newer than `seen`, up to `current`, the
 * newest first. None when nothing was seen before (a new install) or nothing is newer.
 */
export function notesToShow(seen: string | null, current: string, releases: readonly ReleaseNotes[] = RELEASES): ReleaseNotes[] {
  if (!seen) return [];
  return releases.filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The notes of one release, if it has any. */
export function releaseNotes(version: string, releases: readonly ReleaseNotes[] = RELEASES): ReleaseNotes | null {
  return releases.find((r) => compareVersions(r.version, version) === 0) ?? null;
}

/** Said on the window to show releases' notes (Settings → About, Developer's preview): `detail` is the versions. */
export const WHATS_NEW_EVENT = 'daocut:whats-new';
export function showWhatsNew(versions: string[]): void {
  window.dispatchEvent(new CustomEvent(WHATS_NEW_EVENT, { detail: versions }));
}
