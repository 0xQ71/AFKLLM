/** Electron <webview> tag for React JSX (webviewTag: true in BrowserWindow). */

type ElectronWebviewHTMLAttributes = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  src?: string
  allowpopups?: boolean | string
  webpreferences?: string
  partition?: string
  useragent?: string
  preload?: string
}

declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: ElectronWebviewHTMLAttributes
    }
  }
}

export {}
