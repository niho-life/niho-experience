/**
 * 日本語の画面の書体「NIHO Sans」(#615) を、globals.css を読まない単独のページ（ホストの招待・ログインのリンク、
 * オフラインの画面）でも同じにするための、インラインの CSS。中身は globals.css の @font-face と html[lang="ja"] の
 * --font-sans と同じ（niho-sans.test.ts が照合する）。端末の書体を名前で指すだけで、何も読み込まない。
 */
export const NIHO_SANS_FONT_FACES =
  '@font-face{font-family:"NIHO Sans";font-weight:100 500;src:local("Hiragino Maru Gothic ProN W4"),local("HiraMaruProN-W4")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:600 700;src:local("Hiragino Sans W6"),local("HiraginoSans-W6")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:800;src:local("Hiragino Sans W7"),local("HiraginoSans-W7")}'
  + '@font-face{font-family:"NIHO Sans";font-weight:900;src:local("Hiragino Sans W8"),local("HiraginoSans-W8")}';

/** 英字の Nunito は単独のページでは読み込まないので、先頭から外す。 */
export const NIHO_SANS_FAMILY =
  '"NIHO Sans","Hiragino Maru Gothic ProN","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,"Noto Sans JP",ui-sans-serif,system-ui,sans-serif';
