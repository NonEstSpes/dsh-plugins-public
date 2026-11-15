# DSH custom plugins

Независимые модули плагинов DeepSeek Harness. У каждого свой `package.json`, версия и тег. Репозиторий содержит исходники и очищенную документацию; готовые проверенные пакеты размещаются в [Releases](https://github.com/NonEstSpes/dsh-plugins-public/releases).

| Модуль | Пакет | Версия |
| --- | --- | --- |
| [Remote control](remote-control/README.md) | `@local/dsh-remote-control` | 0.1.6 |
| [Interactive replies](interactive-replies/README.md) | `@local/interactive-replies` | 1.0.3 |
| [Finance](finance-plugin/README.md) | `@local/dsh-finance` | 0.1.14 |
| [Codex usage](codex-usage/README.md) | `@local/codex-usage` | 1.1.0 |
| [Agent Team model selection](agent-team-model-selection/README.md) | `@local/dsh-agent-team-model-selection` | 0.1.0 |
| [Parchment theme](parchment-theme/README.md) | `@local/parchment-theme` | 1.0.0 |
| [Studio theme](studio-theme/README.md) | `@local/studio-theme` | 1.0.0 |

## Получение и версии

```powershell
git clone https://github.com/NonEstSpes/dsh-plugins-public.git
cd dsh-plugins-public
git pull --ff-only
git tag --list
```

Тег модуля: `<module>@<version>`. Версии SDK/Bridge/переносимого Worker независимы от версии исторического `remote-control/package.json`. Наличие исходников не означает, что все производные native-bundles собираются из одного этого репозитория: сборщики native-пакетов требуют отдельного изменённого checkout DSH. См. ограничения в документации Remote control.

Для установки используйте штатный Plugin Manager и абсолютный путь к каталогу с `package.json`. На Windows Desktop установленный CLI, если `dsh` не находится в PATH:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version
```

Для Studio перед установкой требуется сборка; команды приведены в [документации модуля](studio-theme/README.md). Не копируйте файлы в подписанную установку DSH и не редактируйте профиль вручную.

## Безопасность удалённого обновления

**Нельзя останавливать, удалять или обновлять единственный доступный Worker до проверки независимого канала восстановления.** Другой локальный агент или OpenCode сам по себе не создаёт входящий сетевой доступ. До появления резервного канала можно только проверить версии, скачать и проверить архив, подготовить план; даже согласованная резервная копия изменяемого состояния может требовать остановки процесса.

Публичный Worker-пакет предназначен для **уже спаренной конфигурации v2**, DSH `0.2.2-rc.1` и Node `>=24.9`. Это не мастер первичного спаривания, не обход VPN/TLS и не разрешение менять grants. Скачивание пакета не активирует Worker.

## Приватность

Это новая история публикации, без переноса исходной внутренней Git-истории. В неё не включены личные финансовые инструменты, эксплуатационные handoff/incident-отчёты, конфиги пар, профили, приватные state-журналы и архивы старых repair-комплектов. Старый Controller-архив с диагностическими локальными путями здесь не публикуется.

Перед коммитом проверяйте diff: `.gitignore` не защищает от секретов внутри разрешённых исходников. Не добавляйте реальные адреса инфраструктуры, имена получателей финансовых операций, ключи, токены или настройки устройств. Публичная публикация не меняет разрешения работающих устройств.

## Лицензии

См. [уведомления](THIRD_PARTY_NOTICES.md) и LICENSE отдельных модулей. Общая новая лицензия на весь репозиторий не назначается; существующие лицензии и обязательная атрибуция сохраняются.
