# Apluie

Application web pour smartphone (PWA installable) qui affiche la pluviométrie et, à partir de la V3, l'humidité des sols (SWI) pour n'importe quel lieu : géolocalisation, recherche d'une commune ou d'un village, ou point touché sur la carte.

## Contenu de la V1 (aucune clé API nécessaire)

| Onglet | Contenu | Source |
|---|---|---|
| Carte | Carte, radar de pluie animé, choix d'un point par toucher | OpenStreetMap, RainViewer |
| Prévisions | Pluie par 15 min, heure par heure pour aujourd'hui et demain, 7 jours | Open-Meteo : Météo-France AROME/ARPEGE en France, meilleur modèle disponible ailleurs |
| Historique | De 7 jours à « depuis 1940 », période personnalisée, cumul comparé à la normale | Réanalyse ECMWF ERA5 (via Open-Meteo), complétée par les analyses de modèles pour les ~6 derniers jours |
| Analyses | Cumul sur une période comparé à la normale 1991-2020 (P10/P90, rang depuis 1940), comparaison d'années (hydrologique ou civile), 12 derniers mois comparés à la normale mensuelle | Idem |
| Sol | SWI Copernicus, prévu en V3 | — |

Fonctions pratiques : favoris (enregistrés dans le navigateur), lien partageable (le lieu, l'onglet et les périodes sont encodés dans l'URL), mode sombre automatique.

## Lancer en local

```bash
cd ~/Downloads/Apluie && python3 -m http.server 8765
```

Ouvrir ensuite http://localhost:8765. La géolocalisation ne fonctionne qu'en HTTPS ou sur `localhost`. Pour tester sur un téléphone, passer par la version hébergée (voir ci-dessous).

## Hébergement sur GitHub Pages

1. Créer un dépôt (par exemple `apluie`) et y pousser le contenu de ce dossier.
2. Dans Settings → Pages, choisir comme source la branche `main` et le dossier `/ (root)`.
3. L'app sera servie à l'adresse `https://<compte>.github.io/apluie/`. Sur iPhone : Partager → « Sur l'écran d'accueil ». Sur Android : menu → « Installer l'application ».

## Points d'attention (licences et données)

- **Open-Meteo** : l'API gratuite est réservée à un usage **non commercial**. Un usage interne dans un cabinet de conseil compte comme commercial : il faut prendre un [abonnement API](https://open-meteo.com/en/pricing). Les URL passent alors à `customer-api.open-meteo.com` avec `&apikey=`, et la clé sera placée derrière le Worker Cloudflare de la V2.
- **Tuiles OpenStreetMap** : convient à un usage léger par une équipe. Si l'usage augmente, passer au fond IGN Géoplateforme (France) ou à un fournisseur de tuiles.
- **RainViewer** : gratuit avec attribution. Le radar est limité au niveau de zoom 7, donc pixelisé de près.
- **ERA5** est une grille d'environ 25 km : ses valeurs sont des moyennes sur une maille, pas une mesure de station. Les cumuls peuvent différer de ceux des pluviomètres, surtout en montagne et lors des épisodes méditerranéens. Les observations des stations Météo-France (V2) combleront ce manque.

## Feuille de route

- **V2** : Worker Cloudflare (protège les clés et met les données en cache) et API Météo-France : pluie dans l'heure, radar France, observations de la station la plus proche.
- **V3** : extraction quotidienne du SWI Copernicus (CGLS, T5/T20/T60, 1 km en Europe et 12,5 km ailleurs) par GitHub Actions, courbes SWI avec climatologie depuis 2007, couche SWI sur la carte.

## Structure

```
index.html            page et vues
css/app.css           thème clair/sombre, mise en page mobile
js/app.js             état, navigation, rendu des vues
js/api.js             appels Open-Meteo, IGN, Nominatim, RainViewer
js/stats.js           calculs de dates, cumuls, normales, percentiles
js/charts.js          habillage de Chart.js
js/map.js             carte Leaflet et radar
sw.js                 service worker (coquille de l'app hors ligne)
manifest.webmanifest  installation PWA
```
