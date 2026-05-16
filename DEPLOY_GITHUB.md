# Deploy via GitHub

## Primeira configuracao local

1. O arquivo real `core/config.py` fica fora do Git.
2. O arquivo `core/config.example.py` vai para o GitHub como modelo.
3. Antes do primeiro commit, confira:

```powershell
git status --short
```

O `core/config.py` nao deve aparecer.

## Criar o repositorio

```powershell
git init
git add .
git commit -m "Primeira versao do DataCross"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

## Configurar na producao

Na primeira vez, clone o repositorio ou copie a pasta atualizada. Depois crie o config real:

```powershell
copy core\config.example.py core\config.py
```

Edite `core/config.py` na producao e coloque o Oracle Instant Client correto, senhas e hosts da producao.

## Atualizar a producao depois

```powershell
git pull
python -m pip install -r requirements.txt
python -m py_compile app.py
```

Depois reinicie o processo do `python app.py` para carregar o codigo novo.

Como `core/config.py` esta no `.gitignore`, o `git pull` nao troca a configuracao da producao.
