#!/bin/bash
# Шаг №84: в живой cabinet.html (снимок сервера, патч PR 582 не лёг по контексту) добавить одну строку
# подключения ui-scrollbar.css перед </head>. Остальной файл — как на боевом.
W=/root/claude-rel/w582; F=$W/st/cabinet.html
cp /opt/synapse/sites/synapse/cabinet.html "$F"
grep -q 'ui-scrollbar.css' "$F" || sed -i '0,/<\/head>/s##<link rel="stylesheet" href="ui-scrollbar.css?v=20261107-1">\n</head>#' "$F"
echo "scrollbar_links=$(grep -c 'ui-scrollbar.css' "$F") diff_lines=$(diff /opt/synapse/sites/synapse/cabinet.html "$F" | grep -c '^[<>]')"
cat $W/static.txt
