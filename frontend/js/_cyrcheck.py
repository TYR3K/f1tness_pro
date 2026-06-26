import re

files = ['app.js','page-scan.js','page-diary.js','page-workouts.js',
         'page-supplements.js','page-subscription.js','page-account.js']

BS = '\\'
cyr = re.compile('[Ѐ-ӿ]')

for fn in files:
    s = open(fn, encoding='utf-8').read()
    # Build a map of which char indices are inside line/block comments.
    comment = [False]*len(s)
    i = 0
    n = len(s)
    st = None
    in_s = None
    while i < n:
        c = s[i]
        nxt = s[i+1] if i+1 < n else ''
        if st is None and in_s is None:
            if c == '/' and nxt == '/':
                st = 'line'; comment[i]=comment[i+1]=True; i+=2; continue
            if c == '/' and nxt == '*':
                st = 'block'; comment[i]=comment[i+1]=True; i+=2; continue
            if c in ("'", '"', '`'):
                in_s = c; i+=1; continue
            i += 1
        elif st == 'line':
            comment[i] = True
            if c == '\n':
                st = None
            i += 1
        elif st == 'block':
            comment[i] = True
            if c == '*' and nxt == '/':
                comment[i+1]=True; st=None; i+=2; continue
            i += 1
        elif in_s:
            if c == BS:
                i += 2; continue
            if c == in_s:
                in_s = None
            i += 1
    # Now: for each cyrillic char NOT in a comment, find the enclosing call name.
    flagged = 0
    for m in cyr.finditer(s):
        idx = m.start()
        if comment[idx]:
            continue
        # look back up to 400 chars for the nearest call token opening this string arg
        back = s[max(0, idx-500):idx]
        # Check if within ~ a pick/L/App.pick/labelRu/labelEn/title arrays etc.
        # Heuristic: the string is OK if 'pick(' or 'L(' or 'App.pick(' appears
        # after the last statement boundary. Simpler: check nearest of these tokens.
        last_pick = max(back.rfind('pick('), back.rfind('L('), back.rfind('App.pick('))
        # also allow label arrays labelRu/labelEn and [ru,en] style
        if last_pick == -1:
            # not obviously inside a pick call -> flag with context
            line = s.count('\n',0,idx)+1
            ctx = s[max(0,idx-40):idx+40].replace('\n',' ')
            print('  ', fn, 'line', line, '::', ctx)
            flagged += 1
            if flagged > 8:
                print('   ... (more)')
                break
    if flagged == 0:
        print('OK no stray cyrillic ' + fn)
