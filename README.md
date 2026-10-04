# Hem & vardag

En fristående svensk hemsida för livet hemma: recept, anteckningar, sysslor, inköp, inventarie, djur och viktiga saker att komma ihåg. **Det här projektet innehåller inte träningssidan Formkurva.** Det har egen server, egna konton och egen databas.

![Startsidan i Hem & vardag](docs/hem-vardag.png)

## Vad finns på sidan?

- Anteckningar, recept med ingredienser och måltidsplanering.
- Att göra, återkommande sysslor, hemunderhåll, packlistor och ärenden.
- Inköpslistor och inventarie för mat, städ, badrum, verktyg och förråd.
- Mängd hemma, påfyllningsnivå och bäst före; lägg till inköp eller planera att använda mat snart.
- Djurprofiler för hund, katt, kanin, fågel, fisk, reptil, gnagare, häst och eget djurslag.
- Räkningar, registrerade utgifter och månadssummering.
- Kalender över daterade poster, dokumentlänkar och checklistmallar.
- Egna användarkonton och delat hushåll för upp till 10 personer via inbjudningskod.
- JSON-backup och återställning av listor.

Gäster sparar lokalt på sin enhet. Inloggade användare sparar i PostgreSQL. Listorna blir bara gemensamma om man går med i samma hushåll; då delas **alla hushållslistor**, även anteckningar, dokumentlänkar och utgifter. Sidan kontrollerar versionen vid sparande så att gamla kopior inte skriver över nyare ändringar. Vid konflikt: ta Backup, ladda om och återställ de poster du vill behålla.

Påminnelser är webbläsaraviseringar, inte pushnotiser när sidan är stängd. De kräver att sidan är öppen, att webbläsaren stöder funktionen och normalt HTTPS (eller localhost). Dokumentdelen lagrar länkar och anteckningar, inte filer. Budgeten är en enkel utgiftsöversikt, inte bankkoppling eller bokföring.

## Vad behöver jag?

| Krav | Rekommendation |
|---|---|
| Server | Debian 12/13 eller Ubuntu 22.04/24.04; även Raspberry Pi 4/5 (64-bit), VM eller Proxmox-LXC |
| Minne | Minst 1 GB, helst 2 GB |
| Disk | Minst 5 GB ledigt samt utrymme för databas och backup |
| Program | Docker Engine, Docker Compose v2, Git och curl |
| Nätverk | Ledig port **3010**; internet vid installation och uppdatering |
| Klient | Mobil, surfplatta eller dator med modern webbläsare |

I Proxmox-LXC behöver Docker-stöd vara konfigurerat, vanligtvis `nesting` och `keyctl`. En VM är enklare om du är osäker. Ingen domän behövs hemma. För internetåtkomst rekommenderas HTTPS och en reverse proxy.

![Docker-installationens delar](docs/docker-oversikt.svg)

En Docker Compose-installation startar tre containrar: **web** (sidan och kontona), **db** (PostgreSQL) och **backup** (daglig databasbackup). Databasen exponeras inte på någon port på servern. Projektet använder namnet `hem-vardag` och egna volymer, så Formkurva kan fortsätta köras separat på port 3000.

## Snabbinstallation på Debian/Ubuntu

Kör på servern via SSH. Om git/curl saknas:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
```

Ladda ned och kör installationsskriptet:

```bash
curl -fsSL https://raw.githubusercontent.com/richardstenlund/hem-vardag/main/install.sh -o /tmp/install-hem-vardag.sh
sudo bash /tmp/install-hem-vardag.sh
```

Skriptet installerar Docker om det saknas, klonar till `/opt/hem-vardag`, skapar `.env` med slumpade lösenord, bygger och startar sidan. **Det skriver inte över en befintlig `.env`.** Slutligen visas webbaddress, admin-e-post och lösenord. Spara dessa privat.

Öppna **`http://SERVERNS-IP:3010`**. Hitta serverns IP med `hostname -I`. Du behöver inte lägga till något filnamn efter adressen.

Valfri port och installationsmapp:

```bash
sudo env APP_PORT=3020 HEM_VARDAG_DIR=/opt/hem-vardag bash /tmp/install-hem-vardag.sh
```

Den egna porten används vid en ny installation. Vid uppdatering läses porten ur befintlig `.env`.

## Manuell Docker-installation

Docker och Compose v2 måste redan vara installerade. Kontrollera med `docker --version` och `docker compose version`.

```bash
git clone https://github.com/richardstenlund/hem-vardag.git
cd hem-vardag
cp .env.example .env
nano .env
```

Fyll i:

- `ADMIN_EMAIL`: administratörens e-postadress.
- `ADMIN_PASSWORD`: ett unikt lösenord med minst 12 tecken.
- `DB_PASSWORD`: ett annat långt, slumpat lösenord.
- `APP_URL`: exempelvis `http://192.168.1.50:3010`, med din servers adress.

Spara med Ctrl+O, Enter och avsluta med Ctrl+X. Starta:

```bash
docker compose up -d --build
docker compose ps
curl --fail http://localhost:3010/api/health
```

Hälsokontrollen ska svara med `"ok":true` och `"application":"hem-vardag"`. Öppna sedan `http://SERVERNS-IP:3010` i webbläsaren.

> **Viktigt:** använd en ny projektmapp och en egen `.env`, inte Formkurvas filer eller databasvolym. Radera inte Formkurvas volymer. Konton och data flyttas inte automatiskt mellan projekten.

## Konton och första inloggningen

1. Öppna sidan via serveradressen, **inte genom att dubbelklicka på HTML-filen**.
2. Tryck **Logga in** och använd admin-uppgifterna från `.env` eller installationsskriptet.
3. Välj **Byt lösenord** i menyn och sätt ett eget lösenord. På mobil finns länken i toppfältet.
4. Andra personer väljer **Skapa ett här** i inloggningsrutan och registrerar sitt eget konto.
5. För gemensamma listor: välj **Dela hushåll**, skapa ett hushåll och dela koden. De andra loggar in och väljer **Gå med** med koden.
6. Administratören kan öppna **Administrera konton** och återställa glömda lösenord. Inga hushållslistor visas i adminpanelen.
7. **Manuella roller är standard.** Befintliga konton behåller sina roller och nya konton blir vanliga användare. Välj **Gör till administratör** eller **Gör till användare** och bekräfta. Minst en administratör måste finnas kvar. Roller gäller direkt, även för redan inloggade konton.
8. **Ta bort användare** raderar kontot, dess privata listor och alla inloggningar permanent. Ta först en databasbackup. Delade listor behålls när en medlem tas bort. Äger kontot ett hushåll måste du först välja en annan medlem och **Överför ägarskap**. Om hushållet saknar andra medlemmar behöver ägaren bjuda in någon först. Den sista administratören kan inte tas bort. Kontot i `ADMIN_EMAIL` är också skyddat eftersom det annars återskapas vid omstart; byt inställningen till en annan administratör före borttagning.

**Uppgradering från läget där alla var administratörer:** sätt `ALL_USERS_ADMIN=false` i `.env` och kör `docker compose up -d --build`. Tidigare administratörer behåller rollen tills du ändrar den i kontohanteringen. `ALL_USERS_ADMIN=true` går fortfarande att aktivera, men då får alla konton administratörsbehörighet och manuella rolländringar stängs av. Med öppen registrering kan vem som helst som når sidan då ta över andra konton genom att återställa deras lösenord.

| Logga in eller skapa konto | Anpassad djurprofil |
|---|---|
| ![Inloggningsrutan](docs/inloggning.png) | ![Djurprofil för en katt](docs/djurprofil.png) |

Admin-kontot skapas vid start om e-postadressen inte finns. En omstart ändrar **inte** ett befintligt kontos lösenord. Ingen e-postserver behövs; automatisk lösenordsåterställning via e-post ingår inte.

## Inställningar

| Variabel i `.env` | Betydelse |
|---|---|
| `APP_PORT` | Port på servern; standard 3010. Ändra om upptagen |
| `APP_URL` | Adressen användarna öppnar; ska stämma med HTTP/HTTPS och port |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin som skapas om kontot saknas; lösenord minst 12 tecken |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Egna databasuppgifter. Byt inte efter installation utan databasadministration |
| `SECURE_COOKIES` | `false` för HTTP hemma, `true` bakom HTTPS |
| `ALLOW_REGISTRATION` | `true` låter användare skapa konton; `false` stänger registreringen |
| `ALL_USERS_ADMIN` | Standard `false`: manuella roller, nya konton blir användare. `true` gör alla konton till administratörer vid start och registrering |
| `SESSION_DAYS` | Hur länge inloggningen gäller; standard 30 dagar |

Efter ändring: `docker compose up -d`. Lägg aldrig `.env` eller databasbackuper på GitHub.

## Uppdatera

```bash
cd /opt/hem-vardag
bash update.sh
```

Skriptet tar en databasbackup före uppdateringen, hämtar senaste koden och bygger om containrarna. Eller manuellt:

```bash
git pull --ff-only
docker compose up -d --build
```

Listor och konton ligger kvar i databasvolymen. Stoppa med `docker compose down`. **Använd inte `docker compose down -v`** om du vill behålla databasen och backuperna.

## Säkerhetskopiering

**Backup** på sidan laddar ned aktuella hushållslistor som JSON. **Återställ** slår ihop en sådan kopia med befintliga listor. Det är inte en backup av alla användarkonton.

Containern `backup` tar en databasbackup vid start och sedan varje dygn; äldre än 14 dagar rensas. Backuperna ligger på samma server och bör kopieras till en annan enhet. Kontrollera att tjänsten fungerar med `docker compose logs backup`.

Manuell fullständig databasbackup:

```bash
docker compose exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > hem-vardag.dump
```

Återställning **ersätter nuvarande databasdata**. Ta först en ny backup och stoppa webbapp och automatisk backup:

```bash
docker compose stop web backup
docker compose exec -T db sh -ec 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < hem-vardag.dump
docker compose start web backup
```

## HTTPS och brandvägg

Hemma kan sidan öppnas via HTTP. Om du använder `ufw`: `sudo ufw allow 3010/tcp`. Använd helst VPN för fjärråtkomst. För publicering på internet används HTTPS framför port 3010, exempelvis med Caddy (se [Caddyfile.example](Caddyfile.example)). Sätt `APP_URL=https://din-domän` och `SECURE_COOKIES=true`. Begränsa registrering om sidan inte ska vara öppen för alla.

## Om sidan inte fungerar

```bash
cd /opt/hem-vardag
docker compose ps
docker compose logs --tail=100 web db
curl --fail http://localhost:3010/api/health
```

- **Porten upptagen:** ändra `APP_PORT` och `APP_URL` i `.env`, starta igen.
- **Databasen startar inte:** kontrollera DB-uppgifterna och loggen. Ändrat `DB_PASSWORD` i `.env` ändrar inte automatiskt lösenordet i en befintlig volym.
- **Inloggning fungerar inte över HTTP:** `SECURE_COOKIES` ska vara `false`.
- **Sidan öppnas som `file:///...`:** konton fungerar inte där. Använd Docker-serveradressen.
- **Synkkonflikt:** ta JSON-backup av ändringarna, ladda om sidan och återställ vid behov. Automatisk synk skriver inte över osparade ändringar.
- **Aviseringar saknas:** kontrollera webbläsarens tillåtelse och använd HTTPS; sidan behöver vara öppen.

## Utveckling och tester

Node.js 22 och PostgreSQL 16 rekommenderas. Med PostgreSQL tillgänglig:

```bash
npm ci
DB_HOST=localhost DB_USER=hemvardag DB_NAME=hemvardag DB_PASSWORD=ditt-lösenord npm start
```

API-tester använder en PostgreSQL-kompatibel testdatabas i minnet (`pg-mem`):

```bash
npm ci
npm test
```

Testdatabasen ersätter inte ett riktigt Docker/PostgreSQL-test inför driftsättning.

På en separat testinstallation kan Docker/PostgreSQL-flödet kontrolleras med:

```bash
docker compose exec -T web node < tests/docker-smoke.js
docker compose restart web
# Vänta tills /api/health svarar igen.
docker compose exec -T -e VERIFY_RESTART=true web node < tests/docker-smoke.js
```

Skriptet skapar testkonton och listor. Kör det bara i en testinstallation, inte i ditt riktiga hushåll. Automatisk GitHub Actions-körning ingår inte.
