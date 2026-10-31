"""Shared schemas for questions and source-bound user answers."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class QuestionOption(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)

    @field_validator("label")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("选项不能为空")
        if value.strip() in {"其他", "其它", "其他，我来填写", "其他（自行填写）"}:
            raise ValueError("其他回答入口由界面自动添加，无需重复提供")
        return value.strip()


class QuestionInput(BaseModel):
    question: str = Field(min_length=1, max_length=800)
    options: list[QuestionOption] = Field(min_length=2, max_length=5)
    multiple: bool = False

    @model_validator(mode="after")
    def distinct(self):
        self.question = self.question.strip()
        if not self.question or len({item.label for item in self.options}) != len(self.options):
            raise ValueError("问题不能为空，选项不能重复")
        return self


class OptionRead(QuestionOption):
    id: str


class QuestionRead(BaseModel):
    id: str
    question: str
    options: list[OptionRead]
    multiple: bool = False


class QuestionAnswer(BaseModel):
    question_id: str = Field(min_length=1, max_length=64)
    option_ids: list[str] = Field(min_length=1, max_length=6)
    custom_text: str = Field(default="", max_length=4000)


class ClarificationRead(BaseModel):
    request_id: str
    source_message_id: str = ""
    questions: list[QuestionRead]
    state: Literal["pending", "answered", "superseded"] = "pending"
    answers: list[QuestionAnswer] = Field(default_factory=list)


class ClarificationResponse(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    source_message_id: str = Field(min_length=1, max_length=64)
    answers: list[QuestionAnswer] = Field(min_length=1, max_length=3)
