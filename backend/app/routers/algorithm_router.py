from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal, Optional

from ..routers.auth import get_current_user
from ..models.users import User

router = APIRouter(prefix="/algorithm", tags=["Algorithm Selection"])

_active_algorithm: str = "logistic"

AVAILABLE_ALGORITHMS = {
    "logistic": {
        "id": "logistic",
        "name": "Logistička regresija (SGD)",
        "description": "Brz online model koji se može učiti iz novih primjera (partial_fit). Pogodan za kontinuirano učenje.",
    },
    "decision_tree": {
        "id": "decision_tree",
        "name": "Stablo odluke",
        "description": "Interpretabilno stablo koje daje jasno objašnjenje svake odluke kroz niz if/else pravila.",
    },
    "ebm": {
        "id": "ebm",
        "name": "EBM (Explainable Boosting Machine)",
        "description": "Visoko precizan glass-box model koji prikazuje doprinos svake značajke predviđanju.",
    },
}


class AlgorithmInfo(BaseModel):
    id: str
    name: str
    description: str


class AlgorithmStatus(BaseModel):
    active: str
    algorithms: list


class SetAlgorithmRequest(BaseModel):
    algorithm: Literal["logistic", "decision_tree", "ebm"]


class PredictRequest(BaseModel):
    accuracy: float    # 0–1
    avg_time: float    # seconds
    hints_used: int    # count


class PredictResponse(BaseModel):
    next_difficulty: int
    label_text: str
    reason: str
    algorithm: str
    confidence: Optional[float] = None


@router.get("/status", response_model=AlgorithmStatus)
def get_algorithm_status():
    """Return the currently active algorithm and all available options."""
    return AlgorithmStatus(
        active=_active_algorithm,
        algorithms=list(AVAILABLE_ALGORITHMS.values()),
    )


@router.post("/select", response_model=AlgorithmStatus)
def select_algorithm(
    request: SetAlgorithmRequest,
    current_user: User = Depends(get_current_user),
):
    """Teacher-only: switch the active prediction algorithm."""
    global _active_algorithm

    if current_user.role != "teacher":
        raise HTTPException(status_code=403, detail="Samo nastavnici mogu mijenjati algoritam.")

    _active_algorithm = request.algorithm
    return AlgorithmStatus(
        active=_active_algorithm,
        algorithms=list(AVAILABLE_ALGORITHMS.values()),
    )


@router.post("/predict", response_model=PredictResponse)
def predict_with_active_algorithm(
    data: PredictRequest,
    current_user: User = Depends(get_current_user),
):
    """Run a prediction using whichever algorithm the teacher has selected."""
    algo = _active_algorithm

    if algo == "logistic":
        import pandas as pd
        from ..services.model_state import model, scaler

        X = pd.DataFrame([{
            "accuracy": data.accuracy,
            "avg_time": data.avg_time,
            "hints_used": data.hints_used,
        }])
        X_scaled = scaler.transform(X)
        label = int(model.predict(X_scaled)[0])
        proba = model.predict_proba(X_scaled)[0]
        confidence = float(max(proba))

        label_map = {0: "smanjiti težinu", 1: "zadržati isti level", 2: "povećati težinu"}
        return PredictResponse(
            next_difficulty=label,
            label_text=label_map.get(label, str(label)),
            reason="Logistička regresija predvidjela je na temelju vaše točnosti, vremena i broja pomoći.",
            algorithm="logistic",
            confidence=round(confidence, 3),
        )

    elif algo == "decision_tree":
        from ..services.decision_tree_service import predict_decision_tree
        try:
            result = predict_decision_tree(data.accuracy, data.avg_time, data.hints_used)
            return PredictResponse(**result)
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))

    elif algo == "ebm":
        from ..services.ebm_service import predict_ebm
        try:
            result = predict_ebm(data.accuracy, data.avg_time, data.hints_used)
            return PredictResponse(
                next_difficulty=result["next_difficulty"],
                label_text=result["label_text"],
                reason=result["reason"],
                algorithm=result["algorithm"],
                confidence=result.get("confidence"),
            )
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))

    raise HTTPException(status_code=400, detail=f"Nepoznati algoritam: {algo}")