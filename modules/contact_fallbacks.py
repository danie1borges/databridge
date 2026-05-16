from sqlalchemy import text


def normalized_cpf_sql(field_name):
    return f"REPLACE(REPLACE({field_name}, '.', ''), '-', '')"


def delivery_fallback_cte(cpf_condition_sql=None):
    where_clause = f"WHERE {cpf_condition_sql}" if cpf_condition_sql else ""
    return f"""
        WITH delivery_ranked AS (
            SELECT
                {normalized_cpf_sql('u.cpf')} AS cpf_limpo,
                u.cpf,
                u.celular AS celular_entrega,
                e.endereco AS endereco_entrega,
                s.data_entrega AS data_entrega,
                ROW_NUMBER() OVER (
                    PARTITION BY {normalized_cpf_sql('u.cpf')}
                    ORDER BY s.data_entrega DESC, s.id_solicitacao DESC
                ) AS rn
            FROM sntr_cartao.solicitacao s
            INNER JOIN sntr_cartao.usuario u
                ON u.id_usuario = s.id_usuario
            LEFT JOIN sntr_cartao.entrega e
                ON e.id_solicitacao = s.id_solicitacao
            WHERE s.data_entrega IS NOT NULL
            {"AND " + cpf_condition_sql if cpf_condition_sql else ""}
        ),
        delivery_latest AS (
            SELECT
                cpf_limpo,
                cpf,
                celular_entrega,
                endereco_entrega,
                data_entrega
            FROM delivery_ranked
            WHERE rn = 1
        )
    """


def delivery_fallback_query(cpf_condition_sql=None, extra_where_sql=None):
    extra_where = f"WHERE {extra_where_sql}" if extra_where_sql else ""
    return text(
        delivery_fallback_cte(cpf_condition_sql)
        + f"""
        SELECT
            cpf_limpo,
            cpf,
            celular_entrega,
            endereco_entrega,
            data_entrega
        FROM delivery_latest
        {extra_where}
        """
    )
