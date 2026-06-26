"""
Единый слой активации подписки (расширяемый под разных провайдеров).

Любой провайдер оплаты (Telegram Stars, Tribute, ручная выдача владельцем
и т.д.) в итоге вызывает один и тот же ``activate_premium``. Это держит
логику начисления доступа в одном месте: тип подписки, продление срока,
запись платежа. Так новый провайдер не дублирует бизнес-логику, а лишь
парсит свой формат и передаёт сюда нормализованные данные.

Состав:
  - activate_premium(...) — найти/создать пользователя и выдать/продлить доступ;
  - revoke_premium(...)   — снять доступ (вернуть на бесплатный тариф).

Обе функции максимально устойчивы: вся работа в try/except с логированием,
чтобы сбой начисления (например, гонка в БД) не ронял обработчик webhook
или апдейт бота.
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from backend import config
from backend.models import Payment, User

logger = logging.getLogger(__name__)


def activate_premium(
    db: Session,
    telegram_id: int,
    tariff: str,
    provider: str,
    amount,
    currency: str,
) -> User:
    """
    Активировать (или продлить) премиум-подписку пользователя.

    Параметры:
      - db          — сессия БД;
      - telegram_id — Telegram ID пользователя (если записи нет — создаём
                      минимального пользователя, чтобы не потерять оплату);
      - tariff      — имя тарифа ("monthly" | "yearly" | "lifetime"), из config;
      - provider    — источник оплаты ("stars" | "tribute" | "owner" и т.п.);
      - amount      — сумма платежа (как пришла от провайдера; может быть None/0);
      - currency    — валюта платежа ("XTR" для Stars и т.д.).

    Логика срока:
      - если у тарифа days is None ("lifetime") — ставим subscription_type
        "lifetime", subscription_until = None (бессрочно);
      - иначе subscription_type = имя тарифа; продлеваем от максимума между
        «сейчас» и текущей датой окончания (чтобы покупки СКЛАДЫВАЛИСЬ, а не
        перезаписывали остаток), на tariff["days"] дней.

    В любом случае пишем запись Payment для аудита, коммитим и возвращаем
    обновлённого пользователя. Вся операция обёрнута в try/except: при ошибке
    откатываем транзакцию, логируем и пробрасываем исключение наверх, чтобы
    вызывающий код (webhook/бот) сам решил, как ответить.
    """
    try:
        now = datetime.utcnow()

        # 1) Находим пользователя; если его нет — создаём минимальную запись,
        #    чтобы оплата не потерялась (профиль он заполнит при входе в приложение).
        user = db.query(User).filter(User.telegram_id == telegram_id).first()
        if user is None:
            user = User(telegram_id=telegram_id)
            db.add(user)

        # 2) Параметры тарифа из конфигурации (цены/сроки — из env, не хардкод).
        tariff_cfg = config.tariff_for(tariff)
        if tariff_cfg is None:
            # Неизвестный тариф — не угадываем, явно сообщаем об ошибке.
            raise ValueError(f"Неизвестный тариф: {tariff!r}")

        days = tariff_cfg.get("days")

        # 3) Выставляем тип подписки и дату окончания.
        if days is None:
            # Пожизненная подписка — без даты окончания.
            user.subscription_type = "lifetime"
            user.subscription_until = None
        else:
            # Срочная подписка: продлеваем от большей из дат (now / текущий until),
            # чтобы оплаты складывались, а не «съедали» остаток.
            current_until = getattr(user, "subscription_until", None)
            base = max(now, current_until) if current_until else now
            user.subscription_type = tariff
            user.subscription_until = base + timedelta(days=days)

        # 4) Аудит: запись о платеже.
        payment = Payment(
            telegram_id=telegram_id,
            provider=provider,
            amount=amount,
            currency=currency,
            subscription_type=user.subscription_type,
        )
        db.add(payment)

        db.commit()
        db.refresh(user)

        logger.info(
            "Активирован премиум: telegram_id=%s tariff=%s provider=%s until=%s",
            telegram_id,
            tariff,
            provider,
            user.subscription_until,
        )
        return user

    except Exception as exc:  # noqa: BLE001 — начисление не должно «молча» падать
        logger.error(
            "Ошибка активации премиума (telegram_id=%s tariff=%s provider=%s): %s",
            telegram_id,
            tariff,
            provider,
            exc,
        )
        # Откатываем незавершённую транзакцию, чтобы сессия осталась рабочей.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        # Пробрасываем наверх — вызывающий слой решает, как ответить провайдеру.
        raise


def revoke_premium(db: Session, telegram_id: int) -> User | None:
    """
    Снять премиум-доступ у пользователя (вернуть на бесплатный тариф).

    Сбрасываем subscription_type на "free", обнуляем дату окончания и снимаем
    флаг владельца (is_owner). Используется командой /revokepro от владельца.

    Возвращаем обновлённого пользователя, либо None, если пользователь не
    найден. Ошибки логируем и откатываем, чтобы не уронить вызывающий код.
    """
    try:
        user = db.query(User).filter(User.telegram_id == telegram_id).first()
        if user is None:
            logger.warning(
                "revoke_premium: пользователь telegram_id=%s не найден", telegram_id
            )
            return None

        user.subscription_type = "free"
        user.subscription_until = None
        user.is_owner = False

        db.commit()
        db.refresh(user)

        logger.info("Снят премиум: telegram_id=%s", telegram_id)
        return user

    except Exception as exc:  # noqa: BLE001 — снятие не должно валить вызывающий код
        logger.error(
            "Ошибка снятия премиума (telegram_id=%s): %s", telegram_id, exc
        )
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None
