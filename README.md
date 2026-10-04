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
- Enkel registrering med användarnamn och lösenord, utan e-post; nya konton är vanliga användare. Administratörer kan välja användare, läsare eller administratör. Inaktivering, sessionshantering och administrativ aktivitetslogg.
- Valfri tvåstegsverifiering med autentiseringsapp och engångsåterställningskoder.
- JSON-backup och återställning av listor.
- Namngivna privata eller delade listor, exempelvis en inköpslista per butik.
- Ansvariga personer och vyn **Mina uppgifter**, samt ungefärlig kostnad för inköp.
- Utlånade saker med mottagare, återlämningsdatum och status; service- och vårdhistorik med datum och kostnad.
- Papperskorg i 30 dagar och de senaste 50 versionerna med vem som skapade, ändrade eller tog bort poster.
- Uppladdade PDF-filer, PNG- och JPEG-bilder, även kopplade till en viss post.
- Valfria Web Push-påminnelser när sidan är stängd.

Gäster sparar lokalt på sin enhet. Inloggade användare sparar i PostgreSQL. Befintliga hem-/kontolistor blir gemensamma när man går med i ett hushåll; då delas de gamla listorna och deras filer, även anteckningar, dokumentlänkar och utgifter. Nya namngivna listor kan däremot vara **privata**, även när man tillhör ett hushåll. Sidan kontrollerar versionen vid sparande så att gamla kopior inte skriver över nyare ändringar. Vid konflikt: ta Backup, ladda om och återställ de poster du vill behålla.

Vanliga webbläsaraviseringar kräver att sidan är öppen. För påminnelser när sidan är stängd aktiverar du Web Push under **Listor & verktyg**; det kräver HTTPS, en kompatibel webbläsare och internet på servern. Dokumentdelen lagrar länkar och anteckningar; filer laddas upp under **Listor & verktyg**. Budgeten är en enkel utgiftsöversikt, inte bankkoppling eller bokföring.

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

Skriptet installerar Docker om det saknas, klonar till `/opt/hem-vardag` och frågar efter **ditt valda admin-användarnamn och lösenord** (minst 12 tecken). Lösenordet skrivs inte ut på skärmen och måste bekräftas. Databaslösenordet slumpas. Skriptet skapar `.env`, bygger och startar sidan. **Det skriver inte över en befintlig `.env` eller byter befintliga kontons lösenord.** Vid automatiserad installation kan `ADMIN_USERNAME` och `ADMIN_PASSWORD` anges som miljövariabler; lägg inte lösenord i kommandon som sparas i shellhistoriken.

Snabbinstallationen tillåter inte enkla citattecken eller radbrytningar i adminuppgifterna; använd manuell installation om du behöver sådana tecken.

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

- `ADMIN_USERNAME`: administratörens användarnamn, exempelvis `richard`.
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
4. Du kan använda sidan direkt efter inloggning. Administratörer har även **Administrera konton**. **Kontosäkerhet** innehåller valfri tvåstegsverifiering och dina inloggningar.
5. Administratörer kan välja **Administrera konton → Skapa användare**, ange användarnamn och lösenord (8–256 tecken) och skapa ett vanligt användarkonto. Efter skapandet kan du välja roll och trycka **Spara roll**. Den som skapar kontot förblir inloggad på sitt eget konto. Lämna uppgifterna säkert till den nya användaren; ingen inbjudan eller e-post behövs. Detta fungerar även när offentlig registrering är avstängd. Andra personer kan också trycka **Skapa konto** i toppfältet när registrering är öppen och loggas då in direkt.
6. För gemensamma listor: välj **Dela hushåll**, skapa ett hushåll och dela koden. De andra loggar in och väljer **Gå med** med koden.
7. Administratören kan återställa glömda lösenord. Inga hushållslistor visas i adminpanelen. Lösenordsåterställning stänger kontots inloggningar men tar inte bort tvåstegsverifieringen.
8. **Välj roll efter skapandet.** Nya konton är vanliga användare. Välj **Administratör**, **Användare** eller **Läsare** under **Roll** på kontot och tryck **Spara roll**. Ändringen gäller direkt på servern även för redan inloggade och behålls efter omstart. Ladda om sidan för att uppdatera knapparna efter en rolländring på en annan enhet. Minst en aktiv administratör måste finnas kvar. Tvåstegsverifiering är fortsatt valfri. Om du ändrar din egen roll förlorar du åtkomst till kontohanteringen.
9. Använd helst **Inaktivera konto** när någon inte längre ska ha åtkomst. Alla sessioner avslutas och nya inloggningar blockeras, men kontot och listorna behålls. **Aktivera konto** tillåter inloggning igen. Hushållsmedlemskap behålls; övriga medlemmar kan fortsätta använda de delade listorna. Den sista aktiva administratören kan inte inaktiveras, tas bort eller nedgraderas.
10. **Ta bort användare** raderar kontot, dess privata listor och alla inloggningar permanent. Ta först en databasbackup. Delade listor behålls när en medlem tas bort. Äger kontot ett hushåll måste du först välja en annan medlem och **Överför ägarskap**. Om hushållet saknar andra medlemmar behöver ägaren bjuda in någon först. Kontot i `ADMIN_USERNAME` (eller äldre `ADMIN_EMAIL`) är skyddat eftersom det annars återskapas vid omstart; byt inställningen till en annan administratör före borttagning.

**Viktigt:** nya konton får inte längre automatiskt administratörsbehörighet. Befintliga administratörer behåller dock sin roll; gå igenom kontona efter uppdateringen. Administratörer kan återställa andra kontons lösenord, inaktivera och ta bort dem. Ge endast den rollen till betrodda personer. Tvåstegsverifiering skyddar inloggning till det egna kontot men begränsar inte andra administratörers kontobehörigheter.

| Logga in eller skapa konto | Anpassad djurprofil |
|---|---|
| ![Inloggningsrutan](docs/inloggning.png) | ![Djurprofil för en katt](docs/djurprofil.png) |

Admin-kontot skapas vid start om användarnamnet inte finns. En omstart ändrar **inte** ett befintligt kontos lösenord. Ingen e-postserver behövs; automatisk lösenordsåterställning via e-post ingår inte.

### Enkel registrering och standardadministratör

Standardadministratören skapas vid serverstart med `ADMIN_USERNAME` och `ADMIN_PASSWORD` som du själv väljer i installationen eller `.env`. Äldre `ADMIN_EMAIL` fungerar fortfarande om `ADMIN_USERNAME` inte anges. Det finns inget gemensamt standardlösenord. Om kontot redan finns ändras inte dess lösenord, roll eller tvåstegsverifiering. Befintliga kontons roller och status bevaras.

`ALLOW_REGISTRATION=true` låter personer skapa konto med bara användarnamn och lösenord. Användarnamnet har 2–64 bokstäver (även å, ä och ö), siffror, punkt, bindestreck eller understreck, utan mellanslag. Namn trimmas och sparas med små bokstäver; `Richard` och `richard` är samma namn. Nya konton får vanlig användarroll, även om de skapas i adminpanelen. Listorna är privata tills man delar hushåll eller väljer en delad namngiven lista. Registrering ansluter inte automatiskt någon till ett hushåll. Gamla `ALL_USERS_ADMIN`-inställningar ignoreras.

**Befintliga konton:** logga in med din tidigare e-postadress i fältet **Användarnamn** och samma lösenord. Listor, inloggningar, hushåll och tvåstegsverifiering behålls. Gamla API-klienter med fältet `email` stöds fortfarande. Databasens äldre `email`-kolumner och motsvarande kompatibilitetsfält innehåller nu kontonamn; ingen e-postadress krävs för nya konton.

Kontoinbjudningsfunktionen är borttagen. Gamla inbjudningslänkar och API-adresser fungerar inte längre och `INVITE_ONLY` används inte, även om den finns kvar i en äldre `.env`. Befintliga konton och historiska logghändelser behålls; en äldre inbjudningstabell lämnas oanvänd utan att data raderas vid uppgradering. Sätt `ALLOW_REGISTRATION=false` om du vill stänga registreringen. När den är öppen kan alla som når sidan registrera sig som vanliga användare.

Om det gamla fältet **Kontoinbjudan** fortfarande visas: uppdatera installationen med `bash update.sh` och ladda sedan om sidan med Ctrl+F5 (eller stäng och öppna sidan på mobilen). Sidfilerna måste kontrolleras mot servern vid laddning, och offline-cachen byts vid denna uppgradering. Rensa inte webbplatsdata som första åtgärd: osynkade gästlistor kan då försvinna.

Kontrollera formuläret i den körande webbcontainern:

```bash
docker compose exec -T web node -e "fetch('http://127.0.0.1:3000/').then(r=>r.text()).then(html=>{if(html.includes('inviteToken')||html.includes('invite-field')){console.error('Gammal version: inbjudningsfältet finns kvar');process.exitCode=1}else{console.log('Ny version: ingen kontoinbjudan i formuläret')}}).catch(e=>{console.error(e);process.exitCode=1})"
```

Om containern har den nya versionen men fältet fortfarande visas, kontrollera att webbläsaren använder rätt serveradress och port och att eventuell reverse proxy inte serverar en gammal cachad sida. Hushållets delningskod är separat och finns kvar.

### Tvåstegsverifiering och inloggningar

- Välj **Kontosäkerhet** på startsidan om du vill aktivera tvåstegsverifiering. Den är valfri för alla. Befintlig aktiverad verifiering behålls vid uppdatering; den kan stängas av med ditt lösenord och en appkod eller återställningskod.
- QR-koder genereras lokalt på servern, utan extern QR-tjänst. Nyckeln visas bara under aktiveringen. Bekräfta inom 10 minuter.
- Om du har aktiverat tvåstegsverifiering: ange först användarnamn och lösenord, sedan appkod eller återställningskod. Annars behövs bara användarnamn och lösenord. En appkod kan inte återanvändas; vänta på nästa kod om du nyss använt den. Serverns och telefonens klockor måste vara rätt.
- Varje återställningskod fungerar en gång. **Skapa nya återställningskoder** kräver lösenord och appkod eller befintlig återställningskod och gör alla gamla koder ogiltiga. Ladda ned eller skriv ned dem och förvara separat från telefonen.
- Om telefonen försvinner: logga in med en återställningskod. Under **Kontosäkerhet** väljer du **Byt autentiseringsapp eller nyckel** och anger lösenord samt en annan återställningskod. Skanna den nya QR-koden, bekräfta och spara de nya återställningskoderna. Du kan också välja **Stäng av tvåstegsverifiering** med lösenord och giltig kod.
- Om både appen och samtliga återställningskoder är förlorade krävs hjälp av den som administrerar servern; det finns ingen osäker automatisk förbikoppling via lösenordsåterställning. Ha gärna två administratörer och en säker backup.
- Aktivering avslutar andra inloggningar. Äldre sessioner som saknar verifiering måste bekräftas under **Kontosäkerhet**.
- **Dina inloggningar** visar webbläsare, skapandetid och giltighetstid. Avsluta en inloggning, logga ut här eller välj **Logga ut alla andra enheter**. Inloggningstokens visas aldrig.

### Administrativ aktivitetslogg

Adminpanelen visar aktör, berört konto, tid och åtgärd för skapande, lösenordsåterställning, aktivering/inaktivering, borttagning, ägaröverföring och ändringar av tvåstegsverifiering samt historiska rolländringar. **Visa äldre händelser** hämtar 50 åt gången. Loggen innehåller aldrig lösenord, säkerhetsnycklar, koder eller listinnehåll. Händelser behålls även efter att ett konto tagits bort; kontonamn och äldre e-postadresser finns därmed kvar i loggen. Detta är ingen manipulationssäker extern revisionslogg.

### Rekommenderad användarhantering

| Rättighet | Administratör | Användare | Läsare |
|---|---|---|---|
| Läsa, söka, kalender och ladda ned backup av egna/delade listor | Ja | Ja | Ja |
| Skapa, ändra, bocka av, ta bort, checklistmallar och återställa listor | Ja | Ja | Nej |
| Skapa hushåll | Ja | Ja | Nej |
| Gå med i hushåll via delningskod | Ja | Ja | Ja, utan att slå ihop eller ändra listor |
| Skapa/radera konton, ändra roller, lösenordsåterställning och aktivitetslogg | Ja | Nej | Nej |
| Eget lösenord, egna sessioner och valfri tvåstegsverifiering | Ja | Ja | Ja |

Rollerna ger aldrig automatisk åtkomst till någon annans privata listor eller andra hushåll. Läsare behåller lokala gästlistor på enheten utan att importera dem. När en läsare går med i ett hushåll behålls tidigare privata listor i databasen utan att delas; hushållets listor visas i stället. Administratörer kan dock återställa andras lösenord, så ge endast den rollen till betrodda personer.

Ge varje person ett eget konto. Gör konton som inte behöver hantera andra konton till vanliga användare. Nya konton får användarrollen; stäng ändå offentlig registrering med `ALLOW_REGISTRATION=false` om endast administratörer ska skapa konton. Inaktivera hellre än att radera direkt, ta backup före borttagning och begränsa nätverksåtkomst till hemnät eller VPN. Använd HTTPS om sidan nås utanför hemmet.

## Inställningar

| Variabel i `.env` | Betydelse |
|---|---|
| `APP_PORT` | Port på servern; standard 3010. Ändra om upptagen |
| `APP_URL` | Adressen användarna öppnar; ska stämma med HTTP/HTTPS och port |
| `APP_TIMEZONE` | Tidszon för pushpåminnelser; standard `Europe/Stockholm` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Admin som skapas om kontot saknas; lösenord minst 12 tecken. Äldre `ADMIN_EMAIL` används som reserv |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Egna databasuppgifter. Byt inte efter installation utan databasadministration |
| `SECURE_COOKIES` | `false` för HTTP hemma, `true` bakom HTTPS |
| `ALLOW_REGISTRATION` | `true` låter användare skapa konton; `false` stänger registreringen |
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

Listor och konton ligger kvar i databasvolymen. Befintliga roller, lösenord, hushåll och kontostatus bevaras; vanliga användare blir inte automatiskt administratörer vid omstart. Tvåstegsverifiering krävs inte men befintlig aktiverad verifiering behålls. `INVITE_ONLY` och `ALL_USERS_ADMIN` används inte längre. Sätt `ALLOW_REGISTRATION=true` för enkel registrering. Stoppa med `docker compose down`. **Använd inte `docker compose down -v`** om du vill behålla databasen och backuperna.

## Listor och vardagsverktyg

- Öppna **Listor & verktyg → Ny namngiven lista**, ange namn och välj **Privat** eller **Delad**. Delade listor kräver hushållsmedlemskap. Synligheten väljs vid skapandet; en privat lista delas inte när du går med i ett hushåll.
- Välj lista i toppfältet för att arbeta med dess inköp, anteckningar, recept och övriga typer. **Hem-/kontolistor** är det befintliga innehållet. Gästlistor importeras endast till dessa, inte till en namngiven lista.
- Skapa exempelvis *Matbutiken*, *Byggvaruhuset* och *Djurbutiken*. Varje inköpspost kan ha ungefärlig kostnad och ansvarig person. Kostnaden summeras för ej klara inköp i det aktuella filtret.
- Välj **Ansvarig** när du skapar eller redigerar en post. **Mina uppgifter** visar ej klara tilldelade poster i vald lista. I en privat lista kan bara det egna kontot tilldelas; i en delad lista kan hushållets medlemmar väljas.
- **Utlånade saker** har mottagare och återlämningsdatum som visas i kalendern; bocka av när saken kommit tillbaka. **Service & vårdhistorik** lagrar utförd åtgärd, datum, sak/djur och kostnad. Utförda historikhändelser visas inte som öppna uppgifter eller påminnelser. Lägg nästa planerade datum under exempelvis djur eller hemunderhåll.

### Papperskorg, ändringshistorik och filer

Under **Listor & verktyg**, välj samma lista som på startsidan:

- **Papperskorg:** borttagna listposter kan återställas inom 30 dagar. Utgångna poster döljs direkt och rensas vid sparande eller serverns timvisa städning.
- **Ändringshistorik:** de senaste 50 ändringarna visar aktör, tid och upp till 100 skapade/ändrade/borttagna titlar. **Återställ** ersätter listans innehåll med versionen före ändringen. Återställningen loggas också och borttagna poster går till papperskorgen.
- Både papperskorg och historik följer listans behörighet; administratörsrollen ger inte åtkomst till andra personers privata listor. Läsare kan läsa men inte återställa.
- **Bilder, kvitton & dokument:** ladda upp PDF, PNG eller JPEG, högst 5 MB per fil och 50 MB totalt per lista. Koppla filen till en post för att visa dess nedladdningslänk på posten. Filerna lagras i PostgreSQL och kräver inloggning med åtkomst till listan, inte bara kännedom om länken.
- Filer ingår i databasbackupen. Filborttagning är permanent och går inte till papperskorgen. Återställning av listversioner påverkar inte filer. Befintliga kontolisters filer följer med när en redigerande användare delar hushåll; läsare delar inte sina filer.

### Web Push när sidan är stängd

Aktivera under **Listor & verktyg → Påminnelser när sidan är stängd** på varje enhet. Kräver HTTPS, notifieringstillstånd och en webbläsare med Web Push. Ställ även `APP_URL` till sidans HTTPS-adress, inte localhost; annars är aktivering avstängd med en förklaring. På iPhone/iPad behöver webbappen normalt installeras på hemskärmen. Stöd beror på webbläsare och enhetsinställningar; HTTP över det lokala nätverket räcker inte.

Servern kontrollerar varje minut och skickar högst en generell påminnelse per enhet och lokal dag mellan kl. 09 och 21 i `APP_TIMEZONE`. Den utlöses av ej klara poster med förfallet datum eller passerat bäst före i tillgängliga hem-/kontolistor och namngivna listor. Datum i servicehistoriken avser redan utförda åtgärder och utlöser inte push.

Meddelandet innehåller ingen posttitel eller listinformation. Leveransen går via webbläsarens pushleverantör (Google, Mozilla, Apple eller Windows) och servern behöver utgående internetåtkomst. VAPID-nycklar skapas automatiskt och sparas i databasen. Återställ därför databasen, inte bara listornas JSON, vid flytt till en annan server. Leveransen kan fördröjas eller blockeras av operativsystemet.

**Stäng av för alla mina enheter** tar bort kontots prenumerationer. På en delad enhet bör du stänga av push innan du lämnar över den; vanlig utloggning stänger inte av redan aktiverade påminnelser.

## Säkerhetskopiering

**Backup** på sidan laddar ned innehållet i vald lista som JSON. **Återställ** slår ihop en sådan kopia med innehållet i den valda listan. Den innehåller inte användarkonton, filer, papperskorg, versionshistorik eller pushnycklar. Läsare kan ladda ned JSON men inte återställa den.

Containern `backup` tar en databasbackup vid start och sedan varje dygn; äldre än 14 dagar rensas. Backuperna ligger på samma server och bör kopieras till en annan enhet. Kontrollera att tjänsten fungerar med `docker compose logs backup`.

Databasbackuper innehåller konton, listor, aktivitetslogg och autentiseringsappens hemliga nycklar. Skydda dem lika noga som lösenord, använd krypterad lagring utanför servern och ladda aldrig upp dem till GitHub.

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
