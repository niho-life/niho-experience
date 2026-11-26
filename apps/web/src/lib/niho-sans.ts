/**
 * #670（2026-11-26 オーナー決定）。#615 の NIHO アプリと同じ組み方から、体験サイトの日本語をヒラギノ角ゴに変更。
 * globals.css を読まない招待・ログインのリンクやオフラインの画面でも、同じ端末の書体を使う。
 * @font-face とフォールバックが globals.css と一致することを niho-sans.test.ts で照合する。
 */
export const NIHO_SANS_FONT_FACES =
  '@font-face{font-family:"NIHO Sans";font-weight:100 400;src:local("Hiragino Sans W3"),local("HiraginoSans-W3"),local("Hiragino Kaku Gothic ProN W3"),local("HiraKakuProN-W3")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:500;src:local("Hiragino Sans W5"),local("HiraginoSans-W5")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:600 700;src:local("Hiragino Sans W6"),local("HiraginoSans-W6"),local("Hiragino Kaku Gothic ProN W6"),local("HiraKakuProN-W6")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:800;src:local("Hiragino Sans W7"),local("HiraginoSans-W7")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:900;src:local("Hiragino Sans W8"),local("HiraginoSans-W8")}';

/** 英字の Nunito は単独のページでは読み込まないので、先頭から外す。 */
export const NIHO_SANS_FAMILY =
  '"NIHO Sans","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,"Noto Sans JP",ui-sans-serif,system-ui,sans-serif';
