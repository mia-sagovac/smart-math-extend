import joblib
import pandas as pd
from pathlib import Path

MODEL_PATH = Path(__file__).resolve().parents[2] / "model" / "model_output" / "ebm_model.joblib"

FEATURES = ["accuracy", "avg_time", "hints_used"]

_ebm_model = None


def get_ebm():
    global _ebm_model
    if _ebm_model is None:
        if not MODEL_PATH.exists():
            raise RuntimeError(
                f"EBM model not found at {MODEL_PATH}. "
                "Train it first: python model/train_ebm.py"
            )
        _ebm_model = joblib.load(MODEL_PATH)
    return _ebm_model


def predict_ebm(accuracy: float, avg_time: float, hints_used: int) -> dict:
    model = get_ebm()

    X = pd.DataFrame([{
        "accuracy": accuracy,
        "avg_time": avg_time,
        "hints_used": hints_used,
    }])[FEATURES]

    proba = model.predict_proba(X)[0]
    pred_class = int(proba.argmax())
    confidence = float(proba[pred_class])

    contributions = _get_contributions(model, X, pred_class)
    explanation = _build_explanation(contributions)

    label_map = {0: "smanjiti težinu", 1: "zadržati isti level", 2: "povećati težinu"}

    return {
        "next_difficulty": pred_class,
        "label_text": label_map.get(pred_class, str(pred_class)),
        "reason": explanation,
        "confidence": round(confidence, 3),
        "algorithm": "ebm",
        "top_features": contributions[:3],
    }


def _get_contributions(model, X, pred_class: int) -> list:
    try:
        local = model.explain_local(X)
        data = local.data(pred_class)
        if data is not None:
            names = data.get("names", FEATURES)
            scores = data.get("scores", [0.0] * len(names))
            contribs = [{"feature": n, "contrib": float(s)} for n, s in zip(names, scores)]
            contribs.sort(key=lambda x: abs(x["contrib"]), reverse=True)
            return contribs
    except Exception:
        pass

    global_exp = model.explain_global()
    gdata = global_exp.data()
    contribs = [
        {"feature": n, "contrib": float(s)}
        for n, s in zip(gdata["names"], gdata["scores"])
    ]
    contribs.sort(key=lambda x: abs(x["contrib"]), reverse=True)
    return contribs


def _build_explanation(contributions: list) -> str:
    nice_names = {
        "accuracy":   "postotak točnih rješenja",
        "avg_time":   "prosječno vrijeme rješavanja",
        "hints_used": "broj korištenih pomoći",
    }
    parts = []
    for f in contributions[:3]:
        sign = "+" if f["contrib"] > 0 else "-"
        display = nice_names.get(f["feature"], f["feature"])
        parts.append(f"{sign}{abs(f['contrib']):.3f} za {display}")
    return "EBM model: " + " | ".join(parts)