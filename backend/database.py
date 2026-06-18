"""
Модуль настройки базы данных (SQLAlchemy).

Здесь создаётся движок (engine), фабрика сессий (SessionLocal),
базовый класс моделей (Base), а также вспомогательные функции:
  - get_db()  — зависимость FastAPI, выдающая сессию и закрывающая её;
  - init_db() — создание всех таблиц при старте приложения.
"""

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# URL подключения к БД. По умолчанию — локальный файл SQLite в корне проекта.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# Для SQLite требуется отключить проверку потока, т.к. FastAPI работает
# с несколькими потоками, а соединение по умолчанию привязано к одному.
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# Движок SQLAlchemy — точка подключения к базе данных.
engine = create_engine(DATABASE_URL, connect_args=connect_args)

# Фабрика сессий. autoflush/autocommit выключены для явного контроля транзакций.
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# Базовый класс для всех ORM-моделей.
Base = declarative_base()


def get_db():
    """
    Зависимость FastAPI: создаёт сессию БД на время запроса
    и гарантированно закрывает её по завершении.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """
    Инициализация БД: импортируем модели (чтобы они зарегистрировались
    в метаданных Base) и создаём все таблицы, если их ещё нет.
    """
    # Импорт моделей обязателен до create_all, иначе таблицы не будут созданы.
    from backend import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
