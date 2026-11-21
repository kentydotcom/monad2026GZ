import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { copy, htmlLang, readLang, writeLang, type Copy, type Lang } from "./i18n";

const LanguageContext = createContext<{ lang: Lang; t: Copy; setLang: (lang: Lang) => void } | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    readLang(typeof localStorage === "undefined" ? null : localStorage),
  );

  useEffect(() => {
    document.documentElement.lang = htmlLang(lang);
    document.querySelector('meta[name="description"]')?.setAttribute("content", copy[lang].lede);
  }, [lang]);

  function setLang(next: Lang) {
    setLangState(next);
    writeLang(localStorage, next);
  }

  return <LanguageContext.Provider value={{ lang, t: copy[lang], setLang }}>{children}</LanguageContext.Provider>;
}

export function useT() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("Language missing");
  return value;
}
