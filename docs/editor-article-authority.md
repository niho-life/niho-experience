# 記事のauthority連携

2026-11-08の現行方針。記事本文・下書き・写真・公開版はExperience DBが正本で、OWNERはExperienceの`/write`から作成・公開する。editor.niho.lifeからExperienceへ公開する経路は停止した。

#480では旧Editor公開本文API、preview token、候補・関連記事checkのExperience route、Editor専用配備flag・origin・secretを撤去する。旧`/editor/*`は410を返し、保存済みDBデータやmigrationは削除しない。過去の設計判断は[ADR 0002](adr/0002-guide-content.md)の「2026-10-30」「2026-11-07」に残す。

## 責任分界

- Experienceは記事本文・下書き・写真・公開版、カテゴリ、提供者と体験の現在状態を持つ。記事の編集・公開は記事提供者の現在activeなOWNERに限る。
- NIHOはアカウント、非OWNER writer権限、記事連携の招待・同意・取消を持つ。#481でNIHO writerが`/write`を利用する認可と同意経路を接続する。
- Experienceのprovider-owner確認APIとホスト画面からの招待中継は、#481の連携用に残す。NIHO user ID、メール、credentialはブラウザ・公開API・HTML・ログへ出さない。

## 残すサービス間境界

| API | 用途 |
| --- | --- |
| Experience `POST /internal/article-authority/v1/provider-owner` | NIHOからの要求に対し、指定されたNIHO user IDが現在その提供者のOWNERである場合だけ表示名を返す |
| NIHO `POST /api/internal/editor-article-authority/check` | #481のwriter/link確認に使うNIHO正本のサービスAPI。NIHO側の契約と配備手順を正とする |

Google署名ID token、固定audience、許可済みservice accountで相互認証する。通常のブラウザcookie、自己申告role、user Bearer tokenは内部APIの認証材料にしない。service tokenはserver内だけで使う。
