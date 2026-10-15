# Prima Fila

Diario di film e serie per due: cosa avete visto e il voto di ognuno, cosa vedere dopo (da soli o insieme),
a che episodio siete arrivati con le serie e "stasera cosa guardiamo?" con filtri per umore, durata e piattaforme.

- **Dati solo sul telefono** (IndexedDB). Per passare titoli all'altro telefono si condivide una lista
  (Altro → Manda la lista) che l'altro importa: i ruoli si scambiano da soli in base ai nomi.
- **Catalogo**: [TMDB](https://www.themoviedb.org/) in italiano (chiave in `js/tmdb.js`, sola lettura);
  piattaforme in Italia fornite da JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.
- **Android**: APK "guscio" (cartella `android/`) che apre l'app pubblicata su GitHub Pages e si aggiorna da solo.
- **iPhone**: aprire https://gavao.github.io/prima-fila/ in Safari → Condividi → Aggiungi alla schermata Home.

## Comandi
- Prova in locale: `powershell -ExecutionPolicy Bypass -File serve.ps1` → http://localhost:8095
- Pubblica: `powershell -ExecutionPolicy Bypass -File tools\publish.ps1 "Descrizione"`
- APK: `powershell -ExecutionPolicy Bypass -File android\build.ps1` (con `-Release` lo pubblica su GitHub)
