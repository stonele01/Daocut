/** Make the existing Windows directory build use only this test package's data. No installation or system settings. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENT_IDS } from '../src/agent-definitions.mjs';

const clearKeys = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DOUBAO_ASR_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_SPEECH_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY',
  'FAL_KEY', 'BRAVE_API_KEY', 'PIXABAY_API_KEY', 'TAVILY_API_KEY', 'PEXELS_API_KEY'];

/** appRelativePath permits an inert .cmd stand-in in the launcher tests; delivery uses App\Daocut.exe. */
export function writeNasTestLauncher(root, { appRelativePath = 'App\\Daocut.exe' } = {}) {
  if (!/^(?:[a-z0-9_-]+\\)*[a-z0-9_-]+\.(?:exe|cmd)$/i.test(appRelativePath)) throw new Error('The app must be a relative file inside the package.');
  root = resolve(root);
  const launcher = join(root, '启动测试版.cmd');
  const data = join(root, 'Data');
  if (!existsSync(join(root, appRelativePath))) throw new Error('The complete test app is missing.');
  if (existsSync(launcher) || existsSync(data)) throw new Error('Refusing to overwrite an existing launcher or test data.');
  mkdirSync(join(data, 'AppData'), { recursive: true });
  writeFileSync(join(data, 'AppData/agents.json'), JSON.stringify({
    shown: Object.fromEntries(AGENT_IDS.map(id => [id, false])), disconnected: [...AGENT_IDS], byok: null,
  }, null, 2) + '\n', { flag: 'wx' });
  const lines = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'rem Use this entry, not App\\Daocut.exe. This changes this process only.',
    `if not exist "%~dp0${appRelativePath}" (`,
    '  echo Missing complete test app. Keep the whole package together.',
    '  exit /b 2',
    ')',
    'for /f "tokens=1 delims==" %%V in (\'set DAOCUT_ 2^>nul\') do set "%%V="',
    'for /f "tokens=1 delims==" %%V in (\'set OPENFILM_ 2^>nul\') do set "%%V="',
    ...clearKeys.map(name => `set "${name}="`),
    'set "DAOCUT_HOME=%~dp0Data"',
    'set "DAOCUT_NO_UPDATE_CHECK=1"',
    'set "TEMP=%~dp0Temp"',
    'set "TMP=%~dp0Temp"',
    'for %%D in ("Data\\AppData" "Data\\StudioData" "Data\\Projects" "Temp") do (',
    '  if not exist "%~dp0%%~D" (',
    '    mkdir "%~dp0%%~D"',
    '    if errorlevel 1 exit /b 3',
    '  )',
    ')',
    'pushd "%~dp0"',
    'if errorlevel 1 exit /b 3',
    `call "%~dp0${appRelativePath}" %*`,
    'set "DAOCUT_TEST_EXIT=%errorlevel%"',
    'popd',
    'endlocal & exit /b %DAOCUT_TEST_EXIT%',
    '',
  ];
  writeFileSync(launcher, lines.join('\r\n'), { encoding: 'ascii', flag: 'wx' });
  return launcher;
}
