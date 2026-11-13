# At 390 px every page scrolls horizontally (global shell header)

`documentElement.scrollWidth` is 838 px at a 390 px viewport on Missions list, Vue d'ensemble, Statistiques and Résultats, in both themes. The Mission content itself fits (1 column, grid uses `min(24rem, 100%)`); the width comes from the app shell header, outside this task's scope. Follow-up: find the overflowing shell element (header search/user block) and constrain it.
